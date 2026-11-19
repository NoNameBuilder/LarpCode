/** Models that cost nothing use OpenCode's shared free pool and need no account. */
export function isFreeModel(model: { cost?: ReadonlyArray<{ input: number }> } | undefined) {
  return !!model?.cost?.length && model.cost.every((cost) => cost.input === 0)
}

/**
 * Whether a model is known to need a sign-in that is not configured.
 *
 * Only providers that expose a credential method are considered. Providers configured with their own key or URL
 * keep working without a stored credential, as do local providers that never ask for one.
 */
export function missingModelCredentials(input: {
  readonly model?: { readonly cost?: ReadonlyArray<{ readonly input: number }> | undefined } | undefined
  readonly provider:
    | {
        readonly integrationID?: string | undefined
        readonly settings?: { readonly [key: string]: unknown } | undefined
      }
    | undefined
  readonly integration:
    | {
        readonly methods: ReadonlyArray<{ readonly type: string }>
        readonly connections: ReadonlyArray<unknown>
      }
    | undefined
}) {
  // Catalogs load asynchronously; without a model entry there is nothing to warn about yet.
  if (!input.model) return false
  if (isFreeModel(input.model)) return false
  const provider = input.provider
  if (!provider?.integrationID) return false
  if (provider.settings?.apiKey) return false
  const integration = input.integration
  if (!integration) return false
  if (integration.connections.length > 0) return false
  return integration.methods.some(
    (method) => method.type === "key" || method.type === "oauth" || method.type === "external",
  )
}
