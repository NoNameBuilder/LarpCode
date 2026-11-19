import { Effect } from "effect"
import { CredentialRpcs } from "../../shared/ipc-rpc/credentials"
import { listOpenCodeCredentials } from "../opencode-import"

export const credentialHandlers = CredentialRpcs.toLayer(
  Effect.gen(function* () {
    return CredentialRpcs.of({
      CredentialsListOpenCode: () =>
        Effect.try({
          try: () => listOpenCodeCredentials(),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(Effect.orDie),
    })
  }),
)
