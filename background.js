const DATA_SOURCES = {
    coreConf: "https://raw.githubusercontent.com/bekl1011/rankings/main/core_conferences.json",
    ccfConf: "https://raw.githubusercontent.com/bekl1011/rankings/main/ccf_conferences.json",
    journals: "https://raw.githubusercontent.com/bekl1011/rankings/main/scimago_journals.json"
};

const UPDATE_INTERVAL_MINUTES = 10080; // 7 Tage
const UPDATE_ALARM_NAME = "updateRankings";
const RESOLVER_TIMEOUT_MS = 8000;
const RESOLVER_LIMITS = {
    dblp: { minDelayMs: 750 },
    crossref: { minDelayMs: 1000 }
};

function normalizeMetadataText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/gi, " and ")
        .replace(/&(?:apos|#39);/gi, "'")
        .replace(/&quot;/gi, "\"")
        .replace(/&[a-z0-9#]+;/gi, " ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function scalarText(value) {
    if (Array.isArray(value)) return scalarText(value[0]);
    if (value && typeof value === "object") {
        return scalarText(value.text ?? value._ ?? value.value ?? "");
    }
    return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function metadataLookupKey(paper) {
    return `${normalizeMetadataText(paper?.title)}|${Number(paper?.year) || 0}`;
}

function yearDistance(expected, candidate) {
    const left = Number(expected) || 0;
    const right = Number(candidate) || 0;
    return left && right ? Math.abs(left - right) : Number.POSITIVE_INFINITY;
}

function authorTokens(authors) {
    const values = Array.isArray(authors) ? authors : [authors];
    return new Set(
        values
            .flatMap(value => normalizeMetadataText(scalarText(value)).split(" "))
            .filter(token => token.length >= 3)
            .filter(token => !["and", "the", "et", "al"].includes(token))
    );
}

function authorOverlap(expectedAuthors, candidateAuthors) {
    const expected = authorTokens(expectedAuthors);
    const candidate = authorTokens(candidateAuthors);
    if (!expected.size || !candidate.size) return null;

    let intersection = 0;
    for (const token of expected) if (candidate.has(token)) intersection += 1;
    return intersection / Math.min(expected.size, candidate.size);
}

function publicationTypeFromDblp(value) {
    const type = normalizeMetadataText(value);
    if (type.includes("journal")) return "journal";
    if (type.includes("conference") || type.includes("workshop")) return "conference";
    return null;
}

function publicationTypeFromCrossref(value) {
    const type = String(value || "").toLowerCase();
    if (type === "journal-article" || type === "journal") return "journal";
    if (type === "proceedings-article" || type === "proceedings") return "conference";
    return null;
}

function dblpAuthors(info) {
    const raw = info?.authors?.author;
    if (!raw) return [];
    return (Array.isArray(raw) ? raw : [raw]).map(scalarText).filter(Boolean);
}

function parseDblpCandidates(payload) {
    const rawHits = payload?.result?.hits?.hit;
    const hits = rawHits ? (Array.isArray(rawHits) ? rawHits : [rawHits]) : [];

    return hits.map(hit => {
        const info = hit?.info || {};
        return {
            title: scalarText(info.title),
            year: Number(scalarText(info.year)) || null,
            authors: dblpAuthors(info),
            venue: scalarText(info.venue),
            publicationType: publicationTypeFromDblp(info.type),
            recordType: scalarText(info.type),
            url: scalarText(info.url)
        };
    }).filter(candidate => candidate.title && candidate.venue);
}

function crossrefYear(item) {
    const dateFields = [
        item?.published,
        item?.issued,
        item?.["published-print"],
        item?.["published-online"]
    ];
    for (const field of dateFields) {
        const year = Number(field?.["date-parts"]?.[0]?.[0]);
        if (year) return year;
    }
    return null;
}

function parseCrossrefCandidates(payload) {
    const items = Array.isArray(payload?.message?.items) ? payload.message.items : [];
    return items.map(item => ({
        title: scalarText(item?.title),
        year: crossrefYear(item),
        authors: (Array.isArray(item?.author) ? item.author : [])
            .map(author => [author?.given, author?.family].filter(Boolean).join(" "))
            .filter(Boolean),
        venue: scalarText(item?.["container-title"]),
        publicationType: publicationTypeFromCrossref(item?.type),
        recordType: scalarText(item?.type),
        doi: scalarText(item?.DOI)
    })).filter(candidate => candidate.title && candidate.venue && candidate.publicationType);
}

function selectHighConfidenceCandidate(paper, candidates, source) {
    const titleNorm = normalizeMetadataText(paper?.title);
    const assessments = candidates.map(candidate => {
        const candidateTitleNorm = normalizeMetadataText(candidate.title);
        const exactTitle = Boolean(titleNorm) && candidateTitleNorm === titleNorm;
        const distance = yearDistance(paper?.year, candidate.year);
        const overlap = authorOverlap(paper?.authors, candidate.authors);
        const eligible = exactTitle && distance <= 1 && Boolean(candidate.venue) && Boolean(candidate.publicationType);
        return {
            candidate,
            exactTitle,
            yearDistance: Number.isFinite(distance) ? distance : null,
            authorOverlap: overlap,
            eligible,
            rejection: !exactTitle
                ? "title-not-exact"
                : !Number.isFinite(distance)
                    ? "year-missing"
                    : distance > 1
                        ? "year-too-far"
                        : !candidate.publicationType
                            ? "publication-type-unsupported"
                            : !candidate.venue
                                ? "venue-missing"
                                : null
        };
    });

    const eligible = assessments.filter(item => item.eligible);
    const exactYear = eligible.filter(item => item.yearDistance === 0);
    const pool = exactYear.length ? exactYear : eligible;

    if (!pool.length) {
        return { resolved: false, source, reason: "no-high-confidence-candidate", assessments };
    }

    const identity = item => `${normalizeMetadataText(item.candidate.venue)}|${item.candidate.publicationType}`;
    const identities = new Set(pool.map(identity));
    let selected = null;

    if (identities.size === 1) {
        selected = [...pool].sort((a, b) => (b.authorOverlap || 0) - (a.authorOverlap || 0))[0];
    } else {
        const ranked = [...pool].sort((a, b) => (b.authorOverlap || 0) - (a.authorOverlap || 0));
        const bestOverlap = ranked[0]?.authorOverlap || 0;
        const secondOverlap = ranked[1]?.authorOverlap || 0;
        if (bestOverlap > 0 && bestOverlap > secondOverlap) selected = ranked[0];
    }

    if (!selected) {
        return { resolved: false, source, reason: "ambiguous-candidates", assessments };
    }

    // ±1 Jahr ist nur zulässig, wenn genau ein plausibler Kandidat existiert.
    if (selected.yearDistance === 1 && pool.length !== 1) {
        return { resolved: false, source, reason: "near-year-not-unique", assessments };
    }

    return {
        resolved: true,
        source,
        confidence: selected.yearDistance === 0 ? "exact-title-year" : "exact-title-near-year",
        venue: selected.candidate.venue,
        year: selected.candidate.year,
        publicationType: selected.candidate.publicationType,
        authors: selected.candidate.authors,
        assessments
    };
}

function createResolverQueue(minDelayMs) {
    let tail = Promise.resolve();
    let lastFinishedAt = 0;
    const pending = new Map();

    return (key, task) => {
        if (pending.has(key)) return pending.get(key);

        const run = tail.catch(() => undefined).then(async () => {
            const waitMs = Math.max(0, minDelayMs - (Date.now() - lastFinishedAt));
            if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
            try {
                return await task();
            } finally {
                lastFinishedAt = Date.now();
            }
        });

        const tracked = run.finally(() => pending.delete(key));
        pending.set(key, tracked);
        tail = tracked.catch(() => undefined);
        return tracked;
    };
}

const resolverQueues = {
    dblp: createResolverQueue(RESOLVER_LIMITS.dblp.minDelayMs),
    crossref: createResolverQueue(RESOLVER_LIMITS.crossref.minDelayMs)
};

let resolverRequestSequence = 0;

async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESOLVER_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            cache: "no-store",
            headers: { "Accept": "application/json" },
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

function buildDblpUrl(paper) {
    const url = new URL("https://dblp.org/search/publ/api");
    url.searchParams.set("q", String(paper?.title || ""));
    url.searchParams.set("format", "json");
    url.searchParams.set("h", "8");
    return url.toString();
}

function buildCrossrefUrl(paper) {
    const url = new URL("https://api.crossref.org/v1/works");
    url.searchParams.set("query.bibliographic", String(paper?.title || ""));
    url.searchParams.set("rows", "5");
    url.searchParams.set(
        "select",
        "DOI,title,container-title,published,issued,published-print,published-online,author,type"
    );
    return url.toString();
}

async function performMetadataLookup(resolver, paper) {
    const requestId = `${resolver}-${Date.now()}-${++resolverRequestSequence}`;
    try {
        const url = resolver === "dblp" ? buildDblpUrl(paper) : buildCrossrefUrl(paper);
        const payload = await fetchJson(url);
        const candidates = resolver === "dblp"
            ? parseDblpCandidates(payload)
            : parseCrossrefCandidates(payload);
        return { ...selectHighConfidenceCandidate(paper, candidates, resolver), requestId };
    } catch (error) {
        return {
            resolved: false,
            source: resolver,
            requestId,
            reason: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
            assessments: []
        };
    }
}

function resolveMetadata(resolver, paper) {
    if (!resolverQueues[resolver]) {
        return Promise.resolve({ resolved: false, source: resolver, reason: "unknown-resolver" });
    }
    if (!normalizeMetadataText(paper?.title)) {
        return Promise.resolve({ resolved: false, source: resolver, reason: "title-missing" });
    }

    const key = metadataLookupKey(paper);
    return resolverQueues[resolver](key, () => performMetadataLookup(resolver, paper));
}

async function ensureUpdateAlarm() {
    const existingAlarm = await chrome.alarms.get(UPDATE_ALARM_NAME);
    if (!existingAlarm) {
        await chrome.alarms.create(UPDATE_ALARM_NAME, {
            periodInMinutes: UPDATE_INTERVAL_MINUTES
        });
    }
}

function reportAlarmError(error) {
    console.error("[Scholar Venue Ranker] Update-Alarm konnte nicht angelegt werden:", error);
}

async function fetchAndCacheRankings() {
    try {
        console.log("[Scholar Venue Ranker] Prüfe auf neue Ranking-Daten...");
        const timestamp = Date.now();

        const results = await Promise.all(
            Object.entries(DATA_SOURCES).map(async ([key, url]) => {
                const response = await fetch(`${url}?t=${timestamp}`, { cache: "no-store" });
                if (!response.ok) {
                    throw new Error(`Fehler bei ${key}: HTTP ${response.status}`);
                }
                return { key, data: await response.json() };
            })
        );

        const storageData = { lastUpdated: timestamp };
        for (const { key, data } of results) storageData[key] = data;
        await chrome.storage.local.set(storageData);

        console.log("[Scholar Venue Ranker] Ranking-Daten aktualisiert.");
        return { ok: true, lastUpdated: timestamp };
    } catch (error) {
        console.error("[Scholar Venue Ranker] Ranking-Update fehlgeschlagen:", error);
        return { ok: false, error: String(error?.message || error) };
    }
}

chrome.runtime.onInstalled.addListener(() => {
    fetchAndCacheRankings();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM_NAME) fetchAndCacheRankings();
});

// MV3-Service-Worker werden regelmäßig beendet und neu gestartet. Dabei kann
// ein Alarm je nach Browser/Version fehlen, obwohl die Extension installiert
// bleibt. Die Prüfung bei jeder Worker-Initialisierung ist idempotent.
ensureUpdateAlarm().catch(reportAlarmError);

// content.js fragt dies ab, falls der Storage beim Laden noch leer ist.
// In älteren Versionen gab es dafür keinen Listener; v12 macht diesen
// Fallback explizit funktionsfähig.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "ensureRankings") {
        fetchAndCacheRankings().then(sendResponse);
        return true; // asynchrone sendResponse-Antwort offen halten
    }

    if (message?.action === "resolveMetadata") {
        resolveMetadata(message.resolver, message.paper).then(sendResponse);
        return true;
    }

    return false;
});

if (globalThis.__SVR_ENABLE_TEST_HOOKS__) {
    globalThis.__SVR_BACKGROUND_TEST_HOOKS__ = {
        authorOverlap,
        buildCrossrefUrl,
        buildDblpUrl,
        createResolverQueue,
        metadataLookupKey,
        normalizeMetadataText,
        parseCrossrefCandidates,
        parseDblpCandidates,
        publicationTypeFromCrossref,
        publicationTypeFromDblp,
        selectHighConfidenceCandidate,
        yearDistance
    };
}
