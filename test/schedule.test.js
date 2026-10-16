// Scheduler tests: the pure cadence rules, and one real sweep end-to-end against
// a temp profile so the write path (backup + byte-range rewrite) is the same one
// the page's "全部解锁" uses.
import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

import {
  DEFAULT_SCHEDULE_INTERVAL,
  MAX_SCHEDULE_INTERVAL,
  MIN_SCHEDULE_INTERVAL,
  normalizeIntervalMinutes,
  normalizeSchedule,
  paths,
  readSchedule,
  runScheduledUnlock,
  scheduleDue,
  writeSchedule,
} from '../src/core.js'

const REASON_LEVELS = { off: null, low: 'low', high: 'high', max: 'max' }
const WORKBUDDY_HEALTH = { service: 'workbuddy2api', healthy: 8, total: 8 }

const UNLOCK_PATCH = `# profile patch
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      locked:
        apiKeyEnv: LOCKED_KEY
        api: openai-completions
        baseURL: https://locked.example/v1
        models:
          - id: m-reason
            name: Reasoner
            contextWindow: 1000000
            maxTokens: 393216
            input:
              - text
- id: mcp-shared
  config:
    servers: []
`

const UNLOCK_CREDENTIALS = `version: 1
records:
  keep-me: untouched
refs:
  LOCKED_KEY: sk-locked
`

function stubFetch(table, health = WORKBUDDY_HEALTH) {
  const seen = []
  const impl = async (url, init) => {
    const key = String(url)
    seen.push({ url: key, authorization: init?.headers?.authorization })
    if (/\/healthz$/.test(key)) {
      if (health === null) return { ok: false, status: 404, json: async () => ({}) }
      return {
        ok: true, status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'x-service' ? health.service : null) },
        json: async () => health,
      }
    }
    return { ok: true, status: 200, json: async () => ({ data: table[key] || [] }) }
  }
  impl.seen = seen
  impl.modelCalls = () => seen.filter((call) => /\/models$/.test(call.url))
  return impl
}

async function sandbox(t) {
  const os = await import('node:os')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsi-schedule-'))
  const home = path.join(root, '.dsh')
  const profileDir = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(profileDir, { recursive: true })
  await fsp.writeFile(path.join(profileDir, 'cordis.patch.yml'), UNLOCK_PATCH, { mode: 0o600 })
  await fsp.writeFile(path.join(home, '.credentials.yaml'), UNLOCK_CREDENTIALS, { mode: 0o600 })
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const env = { ...process.env, DSH_HOME: home, DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'desktop' }
  const resolved = paths(env)
  if (!resolved.scheduleFile.startsWith(root)) {
    throw new Error(`sandbox leaked outside ${root}: ${resolved.scheduleFile}`)
  }
  return { fsp, home, profileDir, env, resolved }
}

/* --------------------------------------------------------------- pure rules */

test('normalizeIntervalMinutes clamps to the advertised cadence', () => {
  assert.equal(normalizeIntervalMinutes(60), 60)
  assert.equal(normalizeIntervalMinutes(59.6), 60, 'rounds to the nearest minute')
  assert.equal(normalizeIntervalMinutes(''), DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(normalizeIntervalMinutes('abc'), DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(normalizeIntervalMinutes(0), DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(normalizeIntervalMinutes(-5), DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(normalizeIntervalMinutes(1), DEFAULT_SCHEDULE_INTERVAL, 'below the floor')
  assert.equal(normalizeIntervalMinutes(4), DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(normalizeIntervalMinutes(MIN_SCHEDULE_INTERVAL), MIN_SCHEDULE_INTERVAL)
  assert.equal(normalizeIntervalMinutes(MAX_SCHEDULE_INTERVAL + 1), DEFAULT_SCHEDULE_INTERVAL, 'above the ceiling')
  assert.equal(normalizeIntervalMinutes(null, 15), 15, 'honours an explicit fallback')
})

test('normalizeSchedule defaults to enabled with a one-interval grace period', () => {
  const now = 1_700_000_000_000
  const fresh = normalizeSchedule({}, now)
  assert.equal(fresh.enabled, true)
  assert.equal(fresh.intervalMinutes, DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(fresh.onlyWorkbuddy, true)
  assert.equal(fresh.lastRunAt, null)
  assert.equal(fresh.nextRunAt, now + DEFAULT_SCHEDULE_INTERVAL * 60000)
  assert.deepEqual(fresh.lastResult, null)
})

test('normalizeSchedule never fires a sweep during startup', () => {
  const now = 1_700_000_000_000
  // A schedule that was never run waits a full interval after "now", not before.
  assert.equal(scheduleDue(normalizeSchedule({}, now), now), false)
  assert.equal(scheduleDue(normalizeSchedule({}, now), now + DEFAULT_SCHEDULE_INTERVAL * 60000), true)
})

test('normalizeSchedule keeps a stored nextRunAt so sleep does not replay missed slots', () => {
  const now = 1_700_000_000_000
  const stored = normalizeSchedule({
    lastRunAt: now - 10 * 60000,
    nextRunAt: now - 5 * 60000,
    intervalMinutes: 60,
  }, now)
  // Stored slot is in the past ⇒ due, and the next one is computed from the run
  // that is about to happen, not from the missed slots.
  assert.equal(scheduleDue(stored, now), true)
  const after = normalizeSchedule({ ...stored, lastRunAt: now, nextRunAt: now + 60 * 60000 }, now)
  assert.equal(after.nextRunAt, now + 60 * 60000)
  assert.equal(scheduleDue(after, now), false)
})

test('normalizeSchedule rejects nonsense instead of trusting it', () => {
  const now = 1_700_000_000_000
  const s = normalizeSchedule({ intervalMinutes: 'weekly', lastRunAt: 'yesterday', nextRunAt: 'soon' }, now)
  assert.equal(s.intervalMinutes, DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(s.lastRunAt, null, 'a non-numeric timestamp is not a timestamp')
  assert.equal(s.nextRunAt, now + DEFAULT_SCHEDULE_INTERVAL * 60000)
  // Only a real boolean disables: the state file is ours, so a stray string must
  // not silently stop the updates.
  assert.equal(normalizeSchedule({ enabled: false }, now).enabled, false)
  assert.equal(normalizeSchedule({ enabled: 0 }, now).enabled, false)
  assert.equal(normalizeSchedule({ enabled: 'false' }, now).enabled, true)
  const off = normalizeSchedule({ enabled: false, nextRunAt: now + 60000 }, now)
  assert.equal(off.nextRunAt, null, 'a disabled schedule has no next slot')
})

test('scheduleDue refuses to run when disabled or unscheduled', () => {
  assert.equal(scheduleDue(null), false)
  assert.equal(scheduleDue({}), false)
  assert.equal(scheduleDue({ enabled: false, nextRunAt: Date.now() + 10 }), false)
  assert.equal(scheduleDue({ enabled: true }), false, 'no slot yet')
})

/* ------------------------------------------------------------ disk + sweep */

test('readSchedule treats a missing or corrupt state file as a fresh schedule', async (t) => {
  const { env, resolved } = await sandbox(t)
  const fresh = await readSchedule(env)
  assert.equal(fresh.enabled, true)
  assert.equal(fresh.intervalMinutes, DEFAULT_SCHEDULE_INTERVAL)
  assert.equal(await fsp.readFile(resolved.scheduleFile, 'utf8').catch(() => ''), '')

  await fsp.mkdir(path.dirname(resolved.scheduleFile), { recursive: true })
  await fsp.writeFile(resolved.scheduleFile, '{ not json', { mode: 0o600 })
  const salvaged = await readSchedule(env)
  assert.equal(salvaged.enabled, true, 'a mangled file must not stop the sweep')
  assert.equal(salvaged.lastRunAt, null)
})

test('writeSchedule persists a 0600 state file round-trips', async (t) => {
  const { env, resolved, fsp: fs } = await sandbox(t)
  const saved = await writeSchedule(env, { enabled: true, intervalMinutes: 15, onlyWorkbuddy: false })
  assert.equal(saved.intervalMinutes, 15)
  assert.equal(await fs.stat(resolved.scheduleFile).then((s) => s.mode & 0o777), 0o600)
  const reloaded = await readSchedule(env)
  assert.equal(reloaded.intervalMinutes, 15)
  assert.equal(reloaded.onlyWorkbuddy, false)
  assert.ok(reloaded.nextRunAt > 0)
})

test('runScheduledUnlock skips a slot that has not arrived and writes nothing', async (t) => {
  const { env, resolved } = await sandbox(t)
  const before = await fsp.readFile(resolved.patchFile, 'utf8')
  const fetchImpl = stubFetch({ 'https://locked.example/v1/models': [{ id: 'm-reason', reasoning_supported_efforts: ['low', 'high', 'max'], can_disable_thinking: true }] })
  const result = await runScheduledUnlock(env, { fetchImpl })
  assert.equal(result.ran, false)
  assert.equal(result.reason, 'not-due')
  assert.equal(fetchImpl.modelCalls().length, 0, 'a fresh schedule never probes during startup')
  assert.equal(await fsp.readFile(resolved.patchFile, 'utf8'), before)
  assert.equal(await fsp.readFile(resolved.scheduleFile, 'utf8').catch(() => ''), '', 'no state file is created by a skipped slot')
})

test('runScheduledUnlock skips when disabled', async (t) => {
  const { env } = await sandbox(t)
  await writeSchedule(env, { enabled: false })
  const result = await runScheduledUnlock(env, { fetchImpl: stubFetch({}) })
  assert.equal(result.ran, false)
  assert.equal(result.reason, 'disabled')
})

test('a due sweep writes the levels, records the run and schedules the next one', async (t) => {
  const { env, resolved } = await sandbox(t)
  const now = Date.now()
  // Due in the past, exactly like "DSH was closed across a slot".
  await writeSchedule(env, { enabled: true, intervalMinutes: 15, lastRunAt: now - 30 * 60000, nextRunAt: now - 60000 })
  const fetchImpl = stubFetch({
    'https://locked.example/v1/models': [
      { id: 'm-reason', supports_reasoning: true, reasoning_supported_efforts: ['low', 'high', 'max'], can_disable_thinking: true, reasoning_default_effort: 'high' },
    ],
  })
  const result = await runScheduledUnlock(env, { fetchImpl })
  assert.equal(result.ran, true)
  assert.equal(result.report.changed, true)
  assert.equal(result.report.unlockedModels, 1)
  assert.deepEqual(result.report.unlockedProviders, ['locked'])
  assert.equal(result.error, null)

  const after = await fsp.readFile(resolved.patchFile, 'utf8')
  const providers = YAML.parse(after).find((entry) => entry.id === 'llm-pi-ai').config.providers
  assert.deepEqual(providers.locked.models[0].reasoningEfforts, REASON_LEVELS)
  assert.equal(providers.locked.models[0].reasoning, 'high')
  // the untouched entry survives byte-for-byte, and a backup was taken
  assert.ok(after.includes('- id: mcp-shared'))
  const backups = (await fsp.readdir(resolved.profileDir)).filter((f) => f.includes('cordis.patch.yml.bak'))
  assert.ok(backups.length >= 1, `expected a backup, got ${backups.join(',')}`)

  const state = await readSchedule(env)
  assert.equal(state.lastRunAt > 0, true)
  assert.equal(state.nextRunAt, state.lastRunAt + 15 * 60000, 'the next slot is one interval after this run')
  assert.deepEqual(state.lastResult, {
    changed: true,
    unlockedModels: 1,
    unlockedProviders: ['locked'],
    failedProviders: [],
  })

  // A second sweep right away is a no-op: the slot moved into the future and the
  // gateway now agrees with the file.
  const again = await runScheduledUnlock(env, { fetchImpl })
  assert.equal(again.ran, false)
  assert.equal(again.reason, 'not-due')
  assert.equal(await fsp.readFile(resolved.patchFile, 'utf8'), after)
})

test('force runs a sweep even when the slot is in the future, and still records it', async (t) => {
  const { env, resolved } = await sandbox(t)
  const now = Date.now()
  await writeSchedule(env, { enabled: true, intervalMinutes: 360, lastRunAt: now - 60000, nextRunAt: now + 300000 })
  const fetchImpl = stubFetch({
    'https://locked.example/v1/models': [
      { id: 'm-reason', supports_reasoning: true, reasoning_supported_efforts: ['high'], can_disable_thinking: true },
    ],
  })
  const result = await runScheduledUnlock(env, { now, fetchImpl, force: true })
  assert.equal(result.ran, true)
  assert.equal(result.report.changed, true)
  const state = await readSchedule(env)
  assert.equal(state.lastRunAt, now)
  assert.equal(state.nextRunAt, now + 360 * 60000, 'forcing a run still advances the cadence')
  assert.equal(YAML.parse(await fsp.readFile(resolved.patchFile, 'utf8'))
    .find((e) => e.id === 'llm-pi-ai').config.providers.locked.models[0].reasoningEfforts.high, 'high')
})

test('a failing gateway is recorded and the cadence survives', async (t) => {
  const { env, resolved } = await sandbox(t)
  const now = Date.now()
  await writeSchedule(env, { enabled: true, intervalMinutes: 60, lastRunAt: now - 2 * 60000, nextRunAt: now - 60000 })
  const before = await fsp.readFile(resolved.patchFile, 'utf8')
  // /healthz answers, /models then blows up: the gateway is judged a WorkBuddy
  // gateway, probed, and fails — the exact shape the page reports as 探测失败.
  const fetchImpl = async (url) => {
    if (/\/healthz$/.test(String(url))) {
      return {
        ok: true, status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'x-service' ? 'workbuddy2api' : null) },
        json: async () => WORKBUDDY_HEALTH,
      }
    }
    throw new Error('connect ECONNREFUSED 10.0.0.1:7863')
  }
  const result = await runScheduledUnlock(env, { now, fetchImpl })
  assert.equal(result.ran, true)
  assert.equal(result.report.changed, false)
  assert.equal(await fsp.readFile(resolved.patchFile, 'utf8'), before, 'a failed sweep never touches the patch')

  const state = await readSchedule(env)
  assert.equal(state.enabled, true, 'one bad gateway must not disable the schedule')
  assert.equal(state.nextRunAt, now + 60 * 60000)
  assert.deepEqual(state.lastResult.failedProviders, ['locked'])
  assert.equal(state.lastError, '')
})

test('the scheduled sweep honours onlyWorkbuddy like the page does', async (t) => {
  const { env, resolved } = await sandbox(t)
  const now = Date.now()
  const gatewayModels = {
    'https://locked.example/v1/models': [
      { id: 'm-reason', supports_reasoning: true, reasoning_supported_efforts: ['high'], can_disable_thinking: true },
    ],
  }

  // A reachable gateway that is not WorkBuddy: /healthz is silent and the model
  // ids carry no cn:/global: namespace. The default sweep must leave it alone.
  await writeSchedule(env, { enabled: true, intervalMinutes: 60, lastRunAt: now - 2 * 60000, nextRunAt: now - 60000 })
  const before = await fsp.readFile(resolved.patchFile, 'utf8')
  const guarded = stubFetch(gatewayModels, null)
  const skipped = await runScheduledUnlock(env, { now, fetchImpl: guarded })
  assert.equal(skipped.ran, true)
  assert.equal(skipped.report.changed, false)
  assert.equal(skipped.report.providers.find((r) => r.id === 'locked').verdict, 'other')
  assert.equal(await fsp.readFile(resolved.patchFile, 'utf8'), before)

  // Widening the scope probes it and writes the level it advertises.
  await writeSchedule(env, { enabled: true, intervalMinutes: 60, onlyWorkbuddy: false, lastRunAt: now - 2 * 60000, nextRunAt: now - 60000 })
  const widened = stubFetch(gatewayModels, null)
  const result = await runScheduledUnlock(env, { now, fetchImpl: widened })
  assert.equal(result.ran, true)
  assert.equal(result.report.changed, true)
  assert.equal(widened.modelCalls().length, 1)
  assert.equal(YAML.parse(await fsp.readFile(resolved.patchFile, 'utf8'))
    .find((e) => e.id === 'llm-pi-ai').config.providers.locked.models[0].reasoningEfforts.high, 'high')
})
