/** Extension OAuth compatibility entry point. */
export { oauthErrorHtml, oauthSuccessHtml, renderPage } from "./auth/oauth/oauth-page.ts";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
