/**
 * Pure version parsing/selection for the update check.
 *
 * Kept free of Obsidian imports so `scripts/update-check-smoke.mjs` can
 * exercise the parsing and selection rules without a host. Network
 * orchestration (jsDelivr probe, mirror manifest fallback) lives in mirror.ts.
 */

/** Stable release tag: dotted numeric only. jsDelivr lists include
 * prereleases (e.g. excalidraw's first item is 2.27.0-beta.8), so the update
 * prompt must not let them through. */
export function isStableVersion(v: string): boolean {
	return /^\d+(\.\d+)+$/.test(v);
}

/** Numeric comparison with prerelease/build suffixes stripped; missing
 * segments count as zero. Returns null when either side has a non-numeric
 * segment after stripping. Host-aligned semantics: prerelease suffixes do not
 * affect ordering, so 2.27.0-beta.8 equals 2.27.0 and neither recommends the
 * other. */
export function compareNumericVersions(a: string, b: string): number | null {
	const core = (v: string): number[] | null => {
		const parts = v.split(/[-+]/)[0].split(".");
		if (!parts.every((p) => /^\d+$/.test(p))) {
			return null;
		}
		return parts.map(Number);
	};
	const pa = core(a);
	const pb = core(b);
	if (!pa || !pb) {
		return null;
	}
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) {
			return diff > 0 ? 1 : -1;
		}
	}
	return 0;
}

/** versions.json: version -> the minimum Obsidian version it requires. */
export type VersionRequirements = Readonly<Record<string, string>>;

/** Highest stable version in a list; null when none. The list is not assumed
 * to be in semantic order (a hotfix tag can be published after a higher one). */
export function pickLatestStableVersion(versions: readonly string[]): string | null {
	return pickUpdateTarget(versions, {}, "");
}

/** Version a host may install: the highest stable version that is not known
 * (through versions.json) to require a newer Obsidian. Versions missing from
 * the table are unknown and stay eligible, so a missing table keeps the
 * previous "numeric max" behavior. */
export function pickUpdateTarget(
	versions: readonly string[],
	requirements: VersionRequirements,
	apiVersion: string,
): string | null {
	let target: string | null = null;
	for (const v of versions) {
		if (!isStableVersion(v)) {
			continue;
		}
		const minAppVersion = requirements[v];
		if (minAppVersion && apiVersion && !hostSatisfies(apiVersion, minAppVersion)) {
			continue;
		}
		if (target === null || (compareNumericVersions(v, target) ?? 0) > 0) {
			target = v;
		}
	}
	return target;
}

function hostSatisfies(apiVersion: string, minAppVersion: string): boolean {
	const diff = compareNumericVersions(apiVersion, minAppVersion);
	return diff !== null && diff >= 0;
}

/** Version the detail card offers by default, mirroring the host: the
 * default-branch manifest version when this Obsidian is new enough, otherwise
 * the highest version in versions.json this host can run. When neither source
 * yields a compatible version the manifest version is kept (the host refuses
 * to install in that case; OpenPlug only shows the requirement). */
export function resolveInstallableVersion(
	manifestVersion: string,
	manifestMinAppVersion: string,
	requirements: VersionRequirements,
	apiVersion: string,
): { version: string; minAppVersion: string } {
	const needsDowngrade =
		manifestMinAppVersion !== "" &&
		apiVersion !== "" &&
		!hostSatisfies(apiVersion, manifestMinAppVersion);
	if (!needsDowngrade) {
		return { version: manifestVersion, minAppVersion: manifestMinAppVersion };
	}
	let best: string | null = null;
	let bestMin = "";
	for (const [version, minAppVersion] of Object.entries(requirements)) {
		if (!isStableVersion(version) || !isStableVersion(minAppVersion)) {
			continue;
		}
		if (!hostSatisfies(apiVersion, minAppVersion)) {
			continue;
		}
		if (best === null || (compareNumericVersions(version, best) ?? 0) > 0) {
			best = version;
			bestMin = minAppVersion;
		}
	}
	if (best === null) {
		return { version: manifestVersion, minAppVersion: manifestMinAppVersion };
	}
	return { version: best, minAppVersion: bestMin };
}

export function parseManifestVersion(text: string): string | null {
	try {
		const data = JSON.parse(text) as { version?: unknown };
		return typeof data.version === "string" && isStableVersion(data.version)
			? data.version
			: null;
	} catch {
		return null;
	}
}

/** Extract every version string from a jsDelivr package payload. Returns null
 * for a malformed payload so the caller can distinguish "no versions" from
 * "the endpoint answered with something unusable". */
export function parseJsDelivrVersionList(text: string): string[] | null {
	try {
		const data = JSON.parse(text) as { versions?: unknown };
		if (!Array.isArray(data.versions)) {
			return null;
		}
		const versions: string[] = [];
		for (const entry of data.versions) {
			if (
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as { version?: unknown }).version === "string"
			) {
				versions.push((entry as { version: string }).version);
			}
		}
		return versions;
	} catch {
		return null;
	}
}

/** Parse the optional versions.json table (version -> minAppVersion). Malformed
 * or non-object payloads return null; entries whose version or requirement is
 * not a stable dotted number are dropped because they cannot be compared. */
export function parseVersionRequirements(text: string): Record<string, string> | null {
	try {
		const data = JSON.parse(text) as unknown;
		if (data === null || typeof data !== "object" || Array.isArray(data)) {
			return null;
		}
		const requirements: Record<string, string> = {};
		for (const [version, minAppVersion] of Object.entries(
			data as Record<string, unknown>,
		)) {
			if (
				isStableVersion(version) &&
				typeof minAppVersion === "string" &&
				isStableVersion(minAppVersion)
			) {
				requirements[version] = minAppVersion;
			}
		}
		return requirements;
	} catch {
		return null;
	}
}
