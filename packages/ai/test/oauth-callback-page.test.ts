import { describe, expect, it } from "vitest";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/auth/oauth/oauth-page.ts";
import type { OAuthCallbackPageOptions } from "../src/auth/types.ts";

describe("OAuth callback page rendering", () => {
	it("keeps the existing escaped Pi page when no renderer is provided", () => {
		const html = oauthErrorHtml("Sign-in <failed>", 'reason="denied"');

		expect(html).toContain("Authentication failed");
		expect(html).toContain("Sign-in &lt;failed&gt;");
		expect(html).toContain("reason=&quot;denied&quot;");
		expect(html).not.toContain("Sign-in <failed>");
	});

	it("passes the complete success and error contract to an opt-in renderer", () => {
		// Regression test for https://github.com/earendil-works/pi/issues/5372
		const rendered: OAuthCallbackPageOptions[] = [];
		const renderer = (options: OAuthCallbackPageOptions): string => {
			rendered.push(options);
			return `${options.heading}: ${options.message}${options.details ? ` (${options.details})` : ""}`;
		};

		expect(oauthSuccessHtml("You can close this window.", renderer)).toBe(
			"Authentication successful: You can close this window.",
		);
		expect(oauthErrorHtml("Authorization was denied.", "access_denied", renderer)).toBe(
			"Authentication failed: Authorization was denied. (access_denied)",
		);
		expect(rendered).toEqual([
			{
				title: "Authentication successful",
				heading: "Authentication successful",
				message: "You can close this window.",
			},
			{
				title: "Authentication failed",
				heading: "Authentication failed",
				message: "Authorization was denied.",
				details: "access_denied",
			},
		]);
	});

	it("falls back to the built-in page when a custom renderer throws", () => {
		const html = oauthErrorHtml("Authorization failed.", "provider_error", () => {
			throw new Error("renderer failed");
		});

		expect(html).toContain("Authentication failed");
		expect(html).toContain("Authorization failed.");
		expect(html).toContain("provider_error");
	});
});
