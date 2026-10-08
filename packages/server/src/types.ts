import type { Layer } from "effect"
import type { Storage, Registry } from "@integration-stepper/core"
import type { SseBroadcaster } from "./sse.js"
import type { Db } from "./db/client.js"

export type ServerEnv = {
  Variables: {
    storageLayer: Layer.Layer<Storage>
    registryLayer: Layer.Layer<Registry>
    sse: SseBroadcaster
    db: Db
  }
}
