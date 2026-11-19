import { Credential } from "@opencode/schema/credential"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

const OpenCodeCredential = Schema.Struct({
  database: Schema.String,
  id: Schema.String,
  integrationID: Schema.String,
  label: Schema.String,
  active: Schema.Boolean,
  value: Credential.Value,
})

const OpenCodeCredentialList = Schema.Struct({
  databases: Schema.Array(Schema.String),
  credentials: Schema.Array(OpenCodeCredential),
  errors: Schema.Array(Schema.String),
})

/** Reads sign-ins saved by an installed OpenCode. The main process opens those databases read-only. */
export const CredentialsListOpenCode = Rpc.make("CredentialsListOpenCode", {
  success: OpenCodeCredentialList,
})

export const CredentialRpcs = RpcGroup.make(CredentialsListOpenCode)

export type OpenCodeCredential = Schema.Schema.Type<typeof OpenCodeCredential>

export type OpenCodeCredentialList = Schema.Schema.Type<typeof OpenCodeCredentialList>
