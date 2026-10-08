import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export const makeDb = (connectionString: string) => {
  const sql = postgres(connectionString)
  return drizzle(sql, { schema })
}

export type Db = ReturnType<typeof makeDb>
