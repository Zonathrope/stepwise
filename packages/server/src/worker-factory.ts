import type { Layer } from "effect"
import type { Storage, Registry, StepperFunction } from "@integration-stepper/core"
import type { Db } from "./db/client.js"
import { Worker } from "./worker.js"

export interface SharedConfig<R> {
  functions: StepperFunction<any, any, R>[]
  layer: Layer.Layer<R>
  storageLayer: Layer.Layer<Storage>
}

export const createWorker = <R>(
  config: SharedConfig<R> & {
    db: Db
    registryLayer: Layer.Layer<Registry>
    concurrency?: number
  },
): Worker => {
  return new Worker({
    db: config.db,
    storageLayer: config.storageLayer,
    registryLayer: config.registryLayer,
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
  })
}
