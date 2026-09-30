/** Only recover explicit count rejections whose provider supplies a usable limit. */
export function imageCountLimit(errorMessage: string | undefined): number | undefined {
	const match = errorMessage?.match(/too\s+many\s+images\s+in\s+request:\s*(\d+)\s*>\s*(\d+)/i);
	if (!match) return undefined;
	const count = Number(match[1]);
	const limit = Number(match[2]);
	return Number.isSafeInteger(count) && Number.isSafeInteger(limit) && limit > 0 && count > limit ? limit : undefined;
}
