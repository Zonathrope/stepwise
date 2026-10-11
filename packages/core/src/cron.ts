/**
 * Minimal 5-field cron expressions (`minute hour day-of-month month day-of-week`), evaluated in UTC.
 * Each field accepts `*`, numbers, ranges (`1-5`), steps (`*\/15`, `0-30/10`) and lists (`1,15,30`).
 * Day-of-week is 0-7 (0 and 7 are Sunday). As in Vixie cron, when both day-of-month and
 * day-of-week are restricted, a day matches if either one does.
 */
export interface CronSchedule {
  readonly expression: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  readonly domRestricted: boolean
  readonly dowRestricted: boolean
}

export class InvalidCronExpressionError extends Error {
  constructor(expression: string, reason: string) {
    super(`Invalid cron expression "${expression}": ${reason}`)
    this.name = "InvalidCronExpressionError"
  }
}

const parseField = (expression: string, field: string, min: number, max: number, label: string): Set<number> => {
  const values = new Set<number>()
  const toInt = (s: string) => {
    if (!/^\d+$/.test(s)) throw new InvalidCronExpressionError(expression, `bad ${label} value "${s}"`)
    const n = Number(s)
    if (n < min || n > max) throw new InvalidCronExpressionError(expression, `${label} ${n} out of range ${min}-${max}`)
    return n
  }
  for (const part of field.split(",")) {
    const [rangePart, stepPart, extra] = part.split("/")
    if (extra !== undefined || rangePart === undefined || rangePart === "") {
      throw new InvalidCronExpressionError(expression, `bad ${label} field "${field}"`)
    }
    const step = stepPart === undefined ? 1 : toInt(stepPart)
    if (step === 0) throw new InvalidCronExpressionError(expression, `${label} step must be > 0`)
    let lo: number
    let hi: number
    if (rangePart === "*") {
      lo = min
      hi = max
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-")
      lo = toInt(a ?? "")
      hi = toInt(b ?? "")
      if (lo > hi) throw new InvalidCronExpressionError(expression, `${label} range ${rangePart} is reversed`)
    } else {
      lo = toInt(rangePart)
      hi = stepPart === undefined ? lo : max
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values
}

export const parseCron = (expression: string): CronSchedule => {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new InvalidCronExpressionError(expression, `expected 5 fields, got ${fields.length}`)
  }
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string]
  const daysOfWeek = parseField(expression, dow, 0, 7, "day-of-week")
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7)
    daysOfWeek.add(0)
  }
  return {
    expression,
    minutes: parseField(expression, min, 0, 59, "minute"),
    hours: parseField(expression, hour, 0, 23, "hour"),
    daysOfMonth: parseField(expression, dom, 1, 31, "day-of-month"),
    months: parseField(expression, month, 1, 12, "month"),
    daysOfWeek,
    domRestricted: !dom.startsWith("*"),
    dowRestricted: !dow.startsWith("*"),
  }
}

const dayMatches = (s: CronSchedule, d: Date): boolean => {
  const dom = s.daysOfMonth.has(d.getUTCDate())
  const dow = s.daysOfWeek.has(d.getUTCDay())
  if (s.domRestricted && s.dowRestricted) return dom || dow
  return dom && dow
}

/** The first tick strictly after `after`, or null if none occurs within ~5 years (e.g. `0 0 31 2 *`). */
export const nextCronTick = (schedule: CronSchedule, after: Date): Date | null => {
  const d = new Date(after.getTime())
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() + 1)
  const limit = after.getTime() + 5 * 366 * 24 * 3600_000
  while (d.getTime() <= limit) {
    if (!schedule.months.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1)
      d.setUTCHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(schedule, d)) {
      d.setUTCDate(d.getUTCDate() + 1)
      d.setUTCHours(0, 0, 0, 0)
      continue
    }
    if (!schedule.hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (!schedule.minutes.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0)
      continue
    }
    return d
  }
  return null
}

/** All ticks in the half-open interval `(from, to]`, oldest first, capped at `limit`. */
export const cronTicksBetween = (schedule: CronSchedule, from: Date, to: Date, limit = 100): Date[] => {
  const ticks: Date[] = []
  let cursor: Date | null = from
  while (ticks.length < limit) {
    cursor = nextCronTick(schedule, cursor)
    if (cursor === null || cursor > to) break
    ticks.push(cursor)
  }
  return ticks
}
