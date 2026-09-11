import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	Context,
	Model,
	ModelsApiStreamOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, type ModelRuntime } from "./model-runtime.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";

export type { ProviderConfigInput } from "./provider-composer.ts";
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
export { clearApiKeyCache } from "./provider-composer.ts";

export type ModelRegistryCredentialSynchronizationOperation = "login" | "logout";

/**
 * A credential was persisted or removed, but the extension-facing model snapshot
 * could not be synchronized. The committed credential is deliberately omitted so
 * an extension cannot accidentally log an API key while reporting the error.
 */
export class ModelRegistryCredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: ModelRegistryCredentialSynchronizationOperation;
	readonly credentialCommitted = true;

	constructor(providerId: string, operation: ModelRegistryCredentialSynchronizationOperation) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`);
		this.name = "ModelRegistryCredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
	}
}

/**
 * Synchronous compatibility facade exposed to extensions.
 * Coding-agent internals use ModelRuntime directly.
 */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	getError(): string | undefined {
		return this.runtime.getError();
	}

	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	getAvailable(): Model<Api>[] {
		return [...this.runtime.getAvailableSnapshot()];
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) {
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				return { ok: true, headers: compatibility.headers };
			}
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error:
					message === "authHeader requires a resolved API key"
						? `No API key found for "${model.provider}"`
						: message,
			};
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** Stream through the configured provider with request-time authentication. */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.runtime.stream(model, context, options);
	}

	/** Stream with provider-neutral options and request-time authentication. */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.runtime.streamSimple(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	/** Run the provider's API-key login flow and persist its credential. */
	async loginApiKey(provider: string, interaction: AuthInteraction): Promise<void> {
		try {
			// A provider can be registered immediately before a setup wizard logs in.
			// Supersede the registration's fire-and-forget refresh so it cannot later
			// publish a pre-credential availability snapshot over the login result.
			await this.runtime.refresh({ allowNetwork: false, providers: [provider], signal: interaction.signal });
			await this.runtime.login(provider, "api_key", interaction);
		} catch (error) {
			if (error instanceof CredentialSynchronizationError) {
				throw new ModelRegistryCredentialSynchronizationError(provider, "login");
			}
			throw error;
		}
	}

	/** Remove the provider's persisted credential. */
	async logout(provider: string, options?: AuthOperationOptions): Promise<void> {
		try {
			await this.runtime.logout(provider, options);
		} catch (error) {
			if (error instanceof CredentialSynchronizationError) {
				throw new ModelRegistryCredentialSynchronizationError(provider, "logout");
			}
			throw error;
		}
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
