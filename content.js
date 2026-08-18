(() => {
    "use strict";

    const SHOW_NOT_FOUND = false;
    const DEBUG = true;

    const CITE_CACHE_ROOT_PREFIX = "scholarCite:";
    const CITE_CACHE_PREFIX = "scholarCite:v13-debug:";
    const CITE_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
    const MAX_CITE_CACHE_ENTRIES = 500;
    const CITE_FETCH_TIMEOUT_MS = 6500;
    const CITE_DELAY_MS = 4000;
    const CITE_DWELL_MS = 1500;
    const MAX_CITE_LOOKUPS_PER_PAGE = 2;

    const METADATA_CACHE_PREFIX = "scholarMetadata:v14:";
    const METADATA_MISS_PREFIX = "scholarMetadataMiss:v14:";
    const METADATA_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
    const METADATA_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const MAX_METADATA_CACHE_ENTRIES = 1000;
    const RESULT_WORKER_COUNT = 3;
    const EXTERNAL_RESOLVER_ORDER = Object.freeze(["dblp", "crossref"]);

    const BADGE_COLORS = Object.freeze({
        CORE: Object.freeze({
            "A*": Object.freeze({ background: "#2D6A4F", text: "#FFFFFF" }),
            A: Object.freeze({ background: "#B7E4C7", text: "#12351F" }),
            B: Object.freeze({ background: "#F4D35E", text: "#3B2F00" }),
            C: Object.freeze({ background: "#B23A48", text: "#FFFFFF" })
        }),
        CCF: Object.freeze({
            A: Object.freeze({ background: "#0057B8", text: "#FFFFFF" }),
            B: Object.freeze({ background: "#5AA6E0", text: "#0B2239" }),
            C: Object.freeze({ background: "#B9DCF5", text: "#12324A" })
            }),
            SJR: Object.freeze({
            Q1: Object.freeze({ background: "#5B148C", text: "#FFFFFF" }),
            Q2: Object.freeze({ background: "#9146B8", text: "#FFFFFF" }),
            Q3: Object.freeze({ background: "#C68AD9", text: "#2B1833" }),
            Q4: Object.freeze({ background: "#E4D8E8", text: "#3A2C40" })
        })
    });
    const NEUTRAL_BADGE_COLOR = Object.freeze({
        background: "#E5E7EB",
        text: "#374151"
    });

    const SUBVENUE_SIGNALS = [
        "workshop", "workshops", "phd forum", "ph d forum",
        "doctoral consortium", "doctoral forum", "student research",
        "companion", "adjunct", "tutorial", "poster", "posters",
        "demo", "demonstration", "work in progress", "wip"
    ];

    const CONFERENCE_SIGNALS = [
        "conference", "proceedings", "symposium", "congress",
        "annual meeting", "colloquium"
    ];

    const JOURNAL_SIGNALS = [
        "journal", "transactions", "letters", "magazine", "review"
    ];

    const ORG_TOKENS = new Set([
        "ieee", "acm", "ifip", "usenix", "sigmobile", "sigcomm",
        "springer", "elsevier", "wiley"
    ]);

    // Organisationsnamen, die als einzelnes Kürzel keine konkrete Venue
    // identifizieren. SIGCOMM/SIGMOBILE stehen absichtlich NICHT hier:
    // diese Kürzel werden in den Ranking-Katalogen selbst als Venue-Identität
    // verwendet und müssen weiter matchen können.
    const GENERIC_ORG_ACRONYMS = new Set([
        "ieee", "acm", "ifip", "usenix",
        "springer", "elsevier", "wiley"
    ]);

    // Für die Identität einer Venue behalten wir Organisations-/Serientokens
    // wie IFIP, USENIX, SIGCOMM oder IEEE bewusst bei. Generische Wörter wie
    // "conference" oder "international" tragen dagegen kaum Identität.
    // Das ist der zentrale Unterschied zu v11: IFIP Networking kann über
    // {ifip, networking} erkannt werden, ohne dass das einzelne Wort
    // "Networking" als gefährliches Akronym behandelt werden muss.
    const VENUE_IDENTITY_STOPWORDS = new Set([
        "the", "a", "an", "of", "on", "and", "for", "in", "to",
        "international", "annual", "conference", "conferences",
        "symposium", "symposia", "congress", "proceedings", "meeting",
        "workshop", "workshops", "journal", "transactions", "letters",
        "magazine", "review", "edition", "volume", "vol", "series"
    ]);

    // Eindeutige historische/alternative Venue-Bezeichnungen, bei denen ein
    // enthaltenes Akronym irreführend sein kann. Diese Aliase überschreiben
    // generische Akronym-Treffer, nachdem der Cite-Datensatz den vollständigen
    // Venue-Namen geliefert hat.
    const DECISIVE_VENUE_ALIASES = [
        {
            type: "conference",
            canonicalName: "Internet Measurement Conference",
            abbr: "IMC",
            phrases: [
                "conference on internet measurement",
                "internet measurement conference"
            ]
        },
        {
            type: "conference",
            canonicalName: "IEEE Network Operations and Management Symposium",
            abbr: "NOMS",
            phrases: [
                "network operations and management symposium"
            ]
        },
        {
            // IEEE veröffentlicht TrustCom und BigDataSE teilweise unter einem
            // gemeinsamen Proceedings-Titel. Der TrustCom-Vollname steht dabei
            // vor "/ BigDataSE"; ohne diese kanonische Identität können zwei
            // starke Akronymtreffer gegeneinander antreten.
            type: "conference",
            canonicalName: "International Conference on Trust, Security and Privacy in Computing and Communications",
            abbr: "TrustCom",
            phrases: [
                "international conference on trust security and privacy in computing and communications",
                "conference on trust security and privacy in computing and communications"
            ]
        }
    ];

    let citeLookupsThisPage = 0;
    let citeLookupBlocked = false;
    let localCacheMaintenancePromise = null;
    let citeQueueTail = Promise.resolve();
    let citeObserver = null;
    let profileObserver = null;
    const citeContexts = new WeakMap();
    const profileContexts = new WeakMap();
    const countedResolverRequests = new Set();

    const debugStats = {
        visibleResolutions: 0,
        metadataCacheHits: 0,
        dblpRequests: 0,
        dblpResolutions: 0,
        crossrefRequests: 0,
        crossrefResolutions: 0,
        citeRequests: 0,
        citeResolutions: 0,
        profileRowsDetected: 0,
        profileRowsObserved: 0,
        profileExternalResolutions: 0,
        profileCiteRequests: 0
    };

    if (DEBUG) {
        console.info("[Scholar Venue Ranker] v14-debug geladen – DBLP/Crossref vor lazy Scholar Cite.");
    }

    if (DEBUG) {
        globalThis.__SVR_DEBUG_STATS__ = debugStats;
        globalThis.__SVR_GET_DEBUG_STATS__ = () => ({ ...debugStats });
    }

    init().catch(error => {
        console.error("[Scholar Venue Ranker] Initialisierung fehlgeschlagen:", error);
    });

    async function init() {
        let stored = await chrome.storage.local.get(["coreConf", "ccfConf", "journals"]);

        if (!hasRankingData(stored)) {
            try {
                await chrome.runtime.sendMessage({ action: "ensureRankings" });
                stored = await chrome.storage.local.get(["coreConf", "ccfConf", "journals"]);
            } catch (error) {
                console.warn("[Scholar Venue Ranker] Ranking-Daten konnten nicht geladen werden:", error);
            }
        }

        if (!hasRankingData(stored)) {
            console.warn("[Scholar Venue Ranker] Keine Ranking-Daten vorhanden.");
            return;
        }

        const rankings = prepareRankings(stored);
        const pageType = detectPageType();
        await processResults(rankings, pageType);
        observeDynamicResults(rankings, pageType);
    }

    function hasRankingData(stored) {
        const core = Array.isArray(stored?.coreConf) ? stored.coreConf.length : 0;
        const sjr = Array.isArray(stored?.journals) ? stored.journals.length : 0;
        const ccf = Array.isArray(stored?.ccfConf)
            ? stored.ccfConf.length
            : (stored?.ccfConf?.conferences?.length || 0) +
              (stored?.ccfConf?.journals?.length || 0);
        return core + sjr + ccf > 0;
    }

    function prepareItem(item, type, system) {
        const name = String(item?.name || "").trim();
        const abbr = String(item?.abbr || "").trim();
        return {
            ...item,
            type,
            system,
            _nameNorm: normalize(name),
            _abbrNorm: normalize(abbr),
            _canonical: canonicalVenue(name),
            _orgFree: organizationFreeCanonical(name),
            _identityTokens: venueIdentityTokens(name),
            _coreName: venueCoreName(name)
        };
    }

    function prepareRankings(stored) {
        const core = (Array.isArray(stored.coreConf) ? stored.coreConf : [])
            .map(item => prepareItem(item, "conference", "CORE"));

        const sjr = (Array.isArray(stored.journals) ? stored.journals : [])
            .map(item => prepareItem(item, "journal", "SJR"));

        let ccfConferences = [];
        let ccfJournals = [];

        if (Array.isArray(stored.ccfConf)) {
            ccfConferences = stored.ccfConf.filter(item => item.type === "conference");
            ccfJournals = stored.ccfConf.filter(item => item.type === "journal");
        } else if (stored.ccfConf && typeof stored.ccfConf === "object") {
            ccfConferences = stored.ccfConf.conferences || [];
            ccfJournals = stored.ccfConf.journals || [];
        }

        ccfConferences = ccfConferences.map(item => prepareItem(item, "conference", "CCF"));
        ccfJournals = ccfJournals.map(item => prepareItem(item, "journal", "CCF"));

        return { core, sjr, ccfConferences, ccfJournals };
    }

    // ------------------------------------------------------------------
    // Normalisierung
    // ------------------------------------------------------------------

    function normalize(value) {
        return String(value || "")
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/IEEEACM/gi, "IEEE ACM")
            .toLowerCase()
            .replace(/[’‘`]/g, "'")
            .replace(/[–—]/g, "-")
            .replace(/\\&/g, " and ")
            .replace(/&/g, " and ")
            .replace(/\u2026|\.\.\./g, " ")
            .replace(/[^a-z0-9*+]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function cleanTitle(value) {
        return String(value || "")
            .replace(/^\s*(?:\[(?:PDF|HTML|BOOK|CITATION)\]\s*)+/i, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function canonicalVenue(value) {
        return normalize(value)
            .replace(/\b(?:19|20)\d{2}\b/g, " ")
            .replace(/\b\d+(?:st|nd|rd|th)\b/g, " ")
            .replace(/\bproceedings of(?: the)?\b/g, " ")
            .replace(/\b(?:the )?proceedings\b/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function organizationFreeCanonical(value) {
        const tokens = canonicalVenue(value).split(" ").filter(Boolean);
        const cleaned = tokens.filter(token => !ORG_TOKENS.has(token));
        return cleaned.join(" ").trim();
    }


    function venueIdentityTokens(value) {
        return new Set(
            canonicalVenue(value)
                .split(" ")
                .filter(token => token.length >= 2)
                .filter(token => !VENUE_IDENTITY_STOPWORDS.has(token))
        );
    }

    // v13: Für lange Vollnamen bilden wir zusätzlich einen sehr konservativen
    // semantischen Kern. Entfernt werden nur generische Venue-Wörter und klar
    // organisatorische Tokens. Besonders ACM-SIG-Bezeichnungen wie SIGOPS
    // dürfen fehlen, ohne dass dadurch die eigentliche Venue-Identität verloren
    // geht (z.B. "ACM SIGOPS Symposium on Operating Systems Principles" vs.
    // "ACM Symposium on Operating Systems Principles").
    function isCoreOrganizationToken(token) {
        const t = String(token || "").toLowerCase();
        if (!t) return false;
        if (ORG_TOKENS.has(t)) return true;
        // ACM Special Interest Groups: SIGOPS, SIGARCH, SIGMETRICS, SIGIR, ...
        if (/^sig[a-z0-9]{2,}$/.test(t)) return true;
        return false;
    }

    // Scholar/Citation-Stile schreiben Editionsnummern teils aus, z.B.
    // "Proceedings of the nineteenth ACM symposium ...". canonicalVenue()
    // entfernt bereits "19th", aber nicht "nineteenth". Solche Ordinale sind
    // keine Venue-Identität. Wir entfernen sie bewusst NUR am Anfang des nach
    // "Proceedings of ..." verbleibenden Namens, damit echte Namensbestandteile
    // an anderer Stelle nicht verschwinden.
    const SIMPLE_TEXTUAL_ORDINALS = new Set([
        "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
        "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth",
        "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth",
        "nineteenth", "twentieth", "thirtieth", "fortieth", "fiftieth",
        "sixtieth", "seventieth", "eightieth", "ninetieth"
    ]);

    const TEXTUAL_ORDINAL_TENS = new Set([
        "twenty", "thirty", "forty", "fifty", "sixty",
        "seventy", "eighty", "ninety"
    ]);

    const TEXTUAL_ORDINAL_UNITS = new Set([
        "first", "second", "third", "fourth", "fifth",
        "sixth", "seventh", "eighth", "ninth"
    ]);

    function stripLeadingTextualOrdinal(tokens) {
        const result = [...tokens];
        if (!result.length) return result;

        // nineteenth ... / twentieth ... / first ...
        if (SIMPLE_TEXTUAL_ORDINALS.has(result[0])) {
            result.shift();
            return result;
        }

        // twenty-first wird durch normalize() zu "twenty first".
        if (
            result.length >= 2 &&
            TEXTUAL_ORDINAL_TENS.has(result[0]) &&
            TEXTUAL_ORDINAL_UNITS.has(result[1])
        ) {
            result.splice(0, 2);
        }

        return result;
    }

    function venueCoreName(value) {
        const tokens = stripLeadingTextualOrdinal(
            canonicalVenue(value).split(" ").filter(Boolean)
        );

        return tokens
            .filter(token => token.length >= 2)
            .filter(token => !VENUE_IDENTITY_STOPWORDS.has(token))
            .filter(token => !isCoreOrganizationToken(token))
            .join(" ")
            .trim();
    }

    function coreNameIsStrong(coreName) {
        const tokens = String(coreName || "").split(" ").filter(Boolean);
        // Drei inhaltliche Tokens verhindern u.a. kurze/generische Kerne wie
        // "machine learning", "networking" oder "test".
        return tokens.length >= 3 && coreName.length >= 18;
    }

    function identityHintFromItem(item) {
        if (!item) return null;
        return {
            abbr: item.abbr || null,
            canonicalName: item.name || null
        };
    }

    function containsWordPhrase(text, phrase) {
        const haystack = ` ${normalize(text)} `;
        const needle = ` ${normalize(phrase)} `;
        return Boolean(needle.trim()) && haystack.includes(needle);
    }

    function tokenStats(a, b) {
        if (!a.size || !b.size) return { intersection: 0, coverage: 0, jaccard: 0 };
        let intersection = 0;
        for (const token of a) if (b.has(token)) intersection += 1;
        const union = a.size + b.size - intersection;
        return {
            intersection,
            coverage: intersection / a.size,
            jaccard: union ? intersection / union : 0
        };
    }

    function extractMeta(metaText) {
        const text = String(metaText || "")
            .replace(/[\u00A0\u202F]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const firstSep = text.indexOf(" - ");
        const lastSep = text.lastIndexOf(" - ");
        if (firstSep < 0) return null;

        const authors = text.slice(0, firstSep)
            .split(",")
            .map(author => author.replace(/\u2026|\.\.\./g, " ").trim())
            .filter(Boolean);

        const rawVenue = (lastSep > firstSep
            ? text.slice(firstSep + 3, lastSep)
            : text.slice(firstSep + 3)).trim();

        const years = [...rawVenue.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
        const year = years.length ? years[years.length - 1] : null;

        const venue = rawVenue
            .replace(/(?:,\s*|\s+)\b(?:19|20)\d{2}\b\s*$/, "")
            .replace(/^[\s.…-]+|[\s.…-]+$/g, "")
            .trim();

        return {
            rawVenue,
            venue,
            year,
            authors,
            truncated: /\u2026|\.\.\./.test(rawVenue)
        };
    }

    function detectPageType() {
        const pathname = String(window.location?.pathname || "");
        const search = String(window.location?.search || "");
        const profileUrl = pathname.endsWith("/citations") && new URLSearchParams(search).has("user");
        const profileDom = Boolean(document.querySelector?.("#gsc_a_b, #gsc_a_t"));
        return profileUrl || profileDom ? "profile" : "search";
    }

    function publicationSelector(pageType) {
        return pageType === "profile"
            ? "#gsc_a_b .gsc_a_tr, #gsc_a_t .gsc_a_tr"
            : ".gs_r.gs_or.gs_scl";
    }

    function extractSearchPaper(row) {
        const titleElement = row.querySelector(".gs_rt");
        const metaElement = row.querySelector(".gs_a");
        if (!titleElement || !metaElement) return null;

        const title = cleanTitle(titleElement.textContent);
        const meta = extractMeta(metaElement.textContent);
        if (!title || !meta?.venue) return null;

        return {
            row,
            pageType: "search",
            titleElement,
            badgePlacement: "append",
            title,
            meta
        };
    }

    function extractProfilePaper(row) {
        const titleElement = row.querySelector(".gsc_a_at");
        if (!titleElement) return null;

        const title = cleanTitle(titleElement.textContent);
        if (!title) return null;

        const detailsCell = row.querySelector(".gsc_a_t") || titleElement.parentElement;
        const grayLines = detailsCell
            ? [...detailsCell.querySelectorAll(".gs_gray")]
                .map(element => String(element.textContent || "").replace(/\s+/g, " ").trim())
            : [];
        const authors = String(grayLines[0] || "")
            .split(",")
            .map(author => author.replace(/\u2026|\.\.\./g, " ").trim())
            .filter(Boolean);
        const rawVenue = String(grayLines[1] || "").trim();
        const yearText = String(
            row.querySelector(".gsc_a_y .gsc_a_h, .gsc_a_y span")?.textContent || ""
        );
        const years = [...`${rawVenue} ${yearText}`.matchAll(/\b(?:19|20)\d{2}\b/g)]
            .map(match => Number(match[0]));
        const year = years.length ? years[years.length - 1] : null;
        const venue = rawVenue
            .replace(/(?:,\s*|\s+)\b(?:19|20)\d{2}\b\s*$/, "")
            .replace(/^[\s.…-]+|[\s.…-]+$/g, "")
            .trim();

        return {
            row,
            pageType: "profile",
            titleElement,
            badgePlacement: "after-title",
            title,
            meta: {
                rawVenue,
                venue,
                year,
                authors,
                truncated: /\u2026|\.\.\./.test(rawVenue)
            }
        };
    }

    function extractPaperMetadata(row, pageType) {
        return pageType === "profile"
            ? extractProfilePaper(row)
            : extractSearchPaper(row);
    }

    function detectSubvenue(title, venue) {
        const normalizedVenue = normalize(venue);
        for (const signal of SUBVENUE_SIGNALS) {
            if (containsWordPhrase(normalizedVenue, signal)) return signal;
        }

        const titleLabel = String(title || "").match(
            /^\s*\[?(poster|demo|demonstration|tutorial|workshop)\]?\s*(?::|[–—-])\s+/i
        );
        return titleLabel ? normalize(titleLabel[1]) : null;
    }

    function inferTypeFromText(value) {
        const text = normalize(value);
        if (!text) return null;

        const conference = CONFERENCE_SIGNALS.some(signal => containsWordPhrase(text, signal));
        const journal = JOURNAL_SIGNALS.some(signal => containsWordPhrase(text, signal));

        if (conference && !journal) return "conference";
        if (journal && !conference) return "journal";
        return null;
    }

    // ------------------------------------------------------------------
    // Sichere Identität / Typbestimmung
    // ------------------------------------------------------------------

    function findDecisiveVenueAlias(values) {
        const normalizedValues = (values || [])
            .map(value => normalize(value))
            .filter(Boolean);

        for (const alias of DECISIVE_VENUE_ALIASES) {
            for (const phrase of alias.phrases) {
                const normalizedPhrase = normalize(phrase);
                if (normalizedValues.some(value => containsWordPhrase(value, normalizedPhrase))) {
                    return alias;
                }
            }
        }
        return null;
    }

    function itemMatchesIdentityHint(item, identityHint) {
        if (!identityHint) return true;

        const hintAbbr = normalize(identityHint.abbr);
        const hintCanonical = canonicalVenue(identityHint.canonicalName);
        const hintOrgFree = organizationFreeCanonical(identityHint.canonicalName);

        if (hintAbbr && item._abbrNorm === hintAbbr) return true;
        if (hintCanonical && item._canonical === hintCanonical) return true;
        if (hintOrgFree && item._orgFree === hintOrgFree) return true;
        return false;
    }

    function aliasResolution(alias, visibleVenue, citeVenue, source) {
        return {
            type: alias.type,
            venue: alias.canonicalName,
            source: `${source}-alias`,
            typeConfidence: "alias",
            identityHint: {
                abbr: alias.abbr,
                canonicalName: alias.canonicalName
            },
            variants: [
                { value: alias.canonicalName, origin: "alias" },
                { value: citeVenue, origin: "cite" },
                { value: visibleVenue, origin: "visible" }
            ].filter(v => v.value)
        };
    }

    function exactIdentityScore(item, value) {
        const v = normalize(value);
        const canonical = canonicalVenue(value);
        const orgFree = organizationFreeCanonical(value);
        if (!v) return 0;

        if (item._nameNorm && v === item._nameNorm) return 100;
        if (item._abbrNorm && v === item._abbrNorm) return 99;
        if (item._canonical && canonical === item._canonical) return 98;
        if (item._orgFree && orgFree === item._orgFree && orgFree.length >= 8) return 97;
        return 0;
    }

    function exactCatalogType(value, rankings) {
        const conferenceItems = [...rankings.core, ...rankings.ccfConferences];
        const journalItems = [...rankings.sjr, ...rankings.ccfJournals];

        const conference = Math.max(0, ...conferenceItems.map(item => exactIdentityScore(item, value)));
        const journal = Math.max(0, ...journalItems.map(item => exactIdentityScore(item, value)));

        if (conference >= 97 && journal < 97) return "conference";
        if (journal >= 97 && conference < 97) return "journal";
        return null;
    }

    function abbreviationParts(abbreviation) {
        return String(abbreviation || "")
            .trim()
            .split(/[^A-Za-z0-9*+]+/)
            .filter(Boolean);
    }

    function isAcronymLikeToken(token) {
        const value = String(token || "");
        if (!value) return false;

        // Reine/gemischte Akronyme wie INFOCOM, CoNEXT, MobiSys, HotOS.
        // Ein normales Wort wie "Networking" ist dagegen KEIN Akronym und
        // darf nicht jedes Venue mit dem Wort "networking" kapern.
        const upperCount = (value.match(/[A-Z]/g) || []).length;
        return /^[A-Z0-9*+]{3,}$/.test(value) ||
            upperCount >= 2 ||
            /\d/.test(value) ||
            /[*+]/.test(value);
    }

    function abbreviationMention(originalValue, abbreviation) {
        const abbr = String(abbreviation || "").trim();
        const parts = abbreviationParts(abbr);
        if (!abbr || !parts.length) return null;

        const normalizedValue = normalize(originalValue);
        const normalizedAbbr = normalize(abbr);

        // Mehrteilige Abkürzungen/Aliasformen wie "USENIX-Security" sind
        // spezifischer als das einzelne Token "USENIX". Dadurch gewinnt das
        // Security Symposium gegen die USENIX Annual Technical Conference.
        if (parts.length >= 2) {
            if (!containsWordPhrase(normalizedValue, normalizedAbbr)) return null;
            return {
                kind: "abbr-phrase",
                position: normalizedValue.indexOf(normalizedAbbr),
                specificity: normalizedAbbr.length
            };
        }

        const part = parts[0];
        if (!isAcronymLikeToken(part)) return null;

        const tokens = String(originalValue || "")
            .split(/[^A-Za-z0-9*+]+/)
            .filter(Boolean);

        const index = tokens.findIndex(token => token.toLowerCase() === part.toLowerCase());
        if (index < 0) return null;

        return {
            kind: "abbr-token",
            position: index,
            specificity: part.length
        };
    }

    function containsAcronymToken(originalValue, abbreviation) {
        return Boolean(abbreviationMention(originalValue, abbreviation));
    }

    // v13: Ein Katalog-Akronym darf auch ohne vorab gesetzten identityHint
    // entscheiden, aber nur bei starker Evidenz. Damit funktioniert z.B.
    // "Proceedings of the ACM SIGCOMM 2025 Conference" -> SIGCOMM, während
    // kurze/mehrdeutige Kürzel wie ITC oder DAS nicht allein ausreichen.
    function strongStandaloneAcronymMention(item, originalValue) {
        const abbr = String(item?.abbr || "").trim();
        if (!abbr) return null;

        const mention = abbreviationMention(originalValue, abbr);
        if (!mention) return null;

        const parts = abbreviationParts(abbr);
        const compact = normalize(abbr).replace(/[^a-z0-9*+]/g, "");
        const compactLength = compact.replace(/[^a-z0-9]/g, "").length;
        const parentheticalLabels = explicitParentheticalAcronyms(originalValue);
        const parentheticalExact = Boolean(item?._abbrNorm) && parentheticalLabels.has(item._abbrNorm);

        // Mehrteilige, spezifische Formen wie USENIX-Security sind stark.
        if (parts.length >= 2 && compactLength >= 7) {
            return { ...mention, evidence: "specific-abbr-phrase" };
        }

        // Reine Organisationskürzel wie USENIX, IEEE, ACM oder IFIP sind
        // keine eindeutige Venue-Identität. Beispiel: In
        // "USENIX Security Symposium" darf das bloße Token "USENIX" nicht
        // gleichzeitig die USENIX Annual Technical Conference matchen.
        // Spezifische Mehrteil-Aliase wie "USENIX-Security" wurden oben
        // bereits akzeptiert und bleiben davon unberührt.
        if (parts.length === 1 && GENERIC_ORG_ACRONYMS.has(normalize(parts[0]))) {
            return null;
        }

        // Lange einteilige Akronyme wie SIGCOMM, INFOCOM, MobiSys, CoNEXT.
        if (parts.length === 1 && compactLength >= 5) {
            return { ...mention, evidence: "long-standalone-acronym" };
        }

        // Kürzere Akronyme (z.B. SOSP/CVPR/NDSS) akzeptieren wir nur, wenn
        // Scholar sie ausdrücklich als Klammerlabel der Venue ausweist.
        if (parts.length === 1 && compactLength >= 3 && parentheticalExact) {
            return { ...mention, evidence: "parenthetical-acronym" };
        }

        return null;
    }

    // v13.3: Kurze Venue-Akronyme (3–4 Zeichen) sind allein weiterhin
    // zu riskant (ITC, DAS, ...). Sie dürfen aber als starke Evidenz gelten,
    // wenn derselbe Cite-Venue-String ZUSÄTZLICH den spezifischen semantischen
    // Kern des ausgeschriebenen Katalognamens enthält.
    //
    // Positiv:
    //   "IEEE 58th Vehicular Technology Conference. VTC 2003-Fall ..."
    //   Katalog: IEEE Vehicular Technology Conference (VTC)
    //   -> VTC + "vehicular technology" bestätigt dieselbe Venue.
    //
    // Negativ:
    //   "Proc. 16th ITC Specialist Seminar ..."
    //   Katalog: IEEE International Test Conference (ITC)
    //   -> "test" ist als Kern zu kurz/generisch und bestätigt ITC nicht.
    //
    //   "... ICMLCN"
    //   Katalog: International Conference on Machine Learning (ICML)
    //   -> ICML erscheint nicht als eigenständiges Token; kein Match.
    function shortAcronymWithCoreSupport(item, originalValue) {
        const abbr = String(item?.abbr || "").trim();
        if (!abbr) return null;

        const parts = abbreviationParts(abbr);
        if (parts.length !== 1) return null;

        const compact = normalize(abbr).replace(/[^a-z0-9*+]/g, "");
        const compactLength = compact.replace(/[^a-z0-9]/g, "").length;

        // Diese Regel ist ausdrücklich nur für die bisherige Lücke bei
        // 3- bis 4-stelligen Einzelakronymen gedacht.
        if (compactLength < 3 || compactLength > 4) return null;

        if (GENERIC_ORG_ACRONYMS.has(normalize(parts[0]))) return null;

        const mention = abbreviationMention(originalValue, abbr);
        if (!mention) return null;

        const catalogCore = String(item?._coreName || "").trim();
        const coreTokens = catalogCore.split(" ").filter(Boolean);

        // Mindestens zwei echte Inhaltswörter; damit scheitert z.B. ITC
        // ("International Test Conference" -> Kern "test").
        if (coreTokens.length < 2 || catalogCore.length < 12) return null;

        const valueCanonical = canonicalVenue(originalValue);

        // Nicht nur Token-Überlappung, sondern der komplette Katalog-Kern muss
        // als zusammenhängende Wortfolge im Cite-Venue stehen. Das hält die
        // Regel konservativ und verhindert neue ICML-/DAS-artige Fehlmatches.
        if (!containsWordPhrase(valueCanonical, catalogCore)) return null;

        return {
            ...mention,
            evidence: "short-acronym+core-name",
            coreName: catalogCore
        };
    }

    function explicitParentheticalAcronyms(value) {
        const result = new Set();
        const text = String(value || "");
        for (const match of text.matchAll(/\(([^()]{2,40})\)/g)) {
            const parts = String(match[1] || "")
                .trim()
                .split(/[^A-Za-z0-9*+]+/)
                .filter(Boolean);
            if (parts.length !== 1) continue;
            const token = parts[0];
            if (!isAcronymLikeToken(token)) continue;
            result.add(normalize(token));
        }
        return result;
    }

    function hasExplicitAcronymConflict(item, value) {
        if (!item?._abbrNorm) return false;
        const labels = explicitParentheticalAcronyms(value);
        if (!labels.size) return false;
        return !labels.has(item._abbrNorm);
    }

    function acronymAdjacentToYear(rawVenue, item) {
        const abbr = String(item?.abbr || "").trim();
        if (!abbr || !containsAcronymToken(rawVenue, abbr)) return false;

        const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
            `(?:\\b${escaped}\\b\\s*[-,:]?\\s*(?:19|20)\\d{2}\\b|\\b(?:19|20)\\d{2}\\b\\s*[-,:]?\\s*${escaped}\\b)`,
            "i"
        );
        return re.test(String(rawVenue || ""));
    }

    function highConfidenceVisibleResolution(meta, title, rankings) {
        if (detectSubvenue(title, meta.rawVenue)) {
            return { type: "subvenue", venue: meta.venue, source: "scholar-visible", typeConfidence: "strong" };
        }

        const visibleAlias = findDecisiveVenueAlias([meta.rawVenue, meta.venue]);
        if (visibleAlias) {
            return aliasResolution(visibleAlias, meta.rawVenue, null, "scholar-visible");
        }

        // Bei einer vollständig sichtbaren Venue akzeptieren wir nur einen
        // expliziten Publication-Type oder eine exakte Katalogidentität.
        // Keine Substring-/Akronym-Heuristik darf den Typ bestimmen.
        if (!meta.truncated) {
            const explicitType = inferTypeFromText(meta.venue);
            const catalogType = exactCatalogType(meta.venue, rankings);
            const type = explicitType || catalogType;
            if (!type) return null;
            return {
                type,
                venue: meta.venue,
                source: "scholar-visible",
                typeConfidence: explicitType ? "strong" : "catalog-exact",
                variants: [{ value: meta.venue, origin: "visible" }]
            };
        }

        // Abgeschnittene Scholar-Venues dürfen direkt aufgelöst werden, wenn
        // genau EINE Katalogidentität über ein Akronym direkt neben dem Jahr
        // identifiziert wird. Anders als v11 tragen wir die Identität danach
        // explizit weiter; der spätere Matcher muss also nicht erneut raten.
        const conferenceHits = [];
        const journalHits = [];

        for (const item of [...rankings.core, ...rankings.ccfConferences]) {
            if (acronymAdjacentToYear(meta.rawVenue, item)) conferenceHits.push(item);
        }
        for (const item of [...rankings.sjr, ...rankings.ccfJournals]) {
            if (acronymAdjacentToYear(meta.rawVenue, item)) journalHits.push(item);
        }

        const conferenceByKey = new Map();
        for (const item of conferenceHits) {
            if (!conferenceByKey.has(catalogIdentityKey(item))) conferenceByKey.set(catalogIdentityKey(item), item);
        }
        const journalByKey = new Map();
        for (const item of journalHits) {
            if (!journalByKey.has(catalogIdentityKey(item))) journalByKey.set(catalogIdentityKey(item), item);
        }

        if (conferenceByKey.size === 1 && journalByKey.size === 0) {
            const item = [...conferenceByKey.values()][0];
            return {
                type: "conference",
                venue: item.name || meta.venue,
                source: "scholar-visible-acronym",
                typeConfidence: "catalog-identity",
                identityHint: identityHintFromItem(item),
                variants: [
                    { value: item.name, origin: "identity" },
                    { value: item.abbr, origin: "identity" },
                    { value: meta.rawVenue, origin: "visible" },
                    { value: meta.venue, origin: "visible" }
                ].filter(v => v.value)
            };
        }
        if (journalByKey.size === 1 && conferenceByKey.size === 0) {
            const item = [...journalByKey.values()][0];
            return {
                type: "journal",
                venue: item.name || meta.venue,
                source: "scholar-visible-acronym",
                typeConfidence: "catalog-identity",
                identityHint: identityHintFromItem(item),
                variants: [
                    { value: item.name, origin: "identity" },
                    { value: item.abbr, origin: "identity" },
                    { value: meta.rawVenue, origin: "visible" },
                    { value: meta.venue, origin: "visible" }
                ].filter(v => v.value)
            };
        }

        return null;
    }

    // ------------------------------------------------------------------
    // Ranking-Matcher: Typ ist bereits bekannt
    // ------------------------------------------------------------------

    function catalogIdentityKey(item) {
        const abbr = normalize(item?.abbr);
        if (abbr.length >= 3) return `abbr:${abbr}`;
        return `name:${item?._orgFree || item?._canonical || item?._nameNorm || ""}`;
    }

    function evaluateRankingItem(item, variants, identityHint = null) {
        let best = null;

        const consider = (candidate) => {
            if (!candidate) return;
            if (!best || candidate.score > best.score) best = candidate;
        };

        for (const variantInfo of variants) {
            const value = String(variantInfo?.value || "").trim();
            if (!value) continue;

            const v = normalize(value);
            const canonical = canonicalVenue(value);
            const orgFree = organizationFreeCanonical(value);
            const identityTokens = venueIdentityTokens(value);
            const coreName = venueCoreName(value);
            const origin = variantInfo.origin || "unknown";

            // Tier 1: echte Identität. Diese Regeln sind symmetrisch/exakt und
            // dürfen ohne weitere Fuzzy-Heuristik entscheiden.
            if (item._nameNorm && v === item._nameNorm) {
                consider({ item, score: 1400, matchedBy: "exact-name", venue: value, origin });
                continue;
            }
            if (item._abbrNorm && v === item._abbrNorm) {
                consider({ item, score: 1390, matchedBy: "exact-abbr", venue: value, origin });
                continue;
            }
            if (item._canonical && canonical === item._canonical) {
                consider({ item, score: 1370, matchedBy: "canonical-name", venue: value, origin });
                continue;
            }
            if (item._orgFree && orgFree === item._orgFree && orgFree.length >= 8) {
                consider({ item, score: 1360, matchedBy: "organization-free-name", venue: value, origin });
                continue;
            }

            // Tier 2: explizit vorab bekannte Identität (z.B. sicher erkannter
            // Scholar-Alias oder eindeutiges Akronym direkt am Jahr). Nur in
            // diesem Fall darf ein eingebettetes Akronym allein genügen.
            if (identityHint && itemMatchesIdentityHint(item, identityHint)) {
                const mention = item._abbrNorm ? abbreviationMention(value, item.abbr) : null;
                if (mention) {
                    consider({ item, score: 1340, matchedBy: "identity-hint-abbr", venue: value, origin });
                    continue;
                }
            }

            // Ein explizites einteiliges Label in Klammern ist negative
            // Evidenz für andere Akronyme: "(... ICMLCN)" darf daher niemals
            // über den enthaltenen Namenspräfix zu ICML werden.
            if (hasExplicitAcronymConflict(item, value)) continue;

            // Tier 2.5a (v13): starkes, alleinstehendes Katalog-Akronym.
            // Kein Substring-Matching: ICML matcht nicht auf ICMLCN. Kurze
            // unbestätigte Kürzel wie ITC/DAS werden ebenfalls nicht akzeptiert.
            const strongAcronym = strongStandaloneAcronymMention(item, value);
            if (strongAcronym) {
                consider({
                    item,
                    score: 1330,
                    matchedBy: `standalone-acronym:${strongAcronym.evidence}`,
                    venue: value,
                    origin
                });
            }

            // Tier 2.5a.5 (v13.3): kurzes Akronym + bestätigter
            // ausgeschriebener Kernname. Das schließt die VTC-Lücke, ohne die
            // Schutzregeln gegen ITC/DAS/ICMLCN aufzuweichen.
            const shortAcronymCore = shortAcronymWithCoreSupport(item, value);
            if (shortAcronymCore) {
                consider({
                    item,
                    score: 1325,
                    matchedBy: `short-acronym-core:${shortAcronymCore.evidence}`,
                    venue: value,
                    origin,
                    coreName: shortAcronymCore.coreName
                });
            }

            // Tier 2.5b (v13): exakter langer semantischer Kernname.
            // Beispiel SOSP:
            //   ACM SIGOPS Symposium on Operating Systems Principles
            //   ACM Symposium on Operating Systems Principles
            // -> Kern in beiden Fällen: "operating systems principles".
            if (
                item._coreName &&
                coreName &&
                item._coreName === coreName &&
                coreNameIsStrong(coreName)
            ) {
                consider({
                    item,
                    score: 1320,
                    matchedBy: "exact-long-core-name",
                    venue: value,
                    origin,
                    coreName
                });
            }

            // Tier 3: konservatives Namensmatching über Identitätstokens.
            // Organisations-/Serientokens bleiben erhalten (IFIP Networking),
            // generische Wörter wie "conference" werden entfernt.
            //
            // Wichtig: Wir verlangen sowohl hohe Abdeckung des Katalognamens
            // ALS AUCH eine hohe Jaccard-Ähnlichkeit. Dadurch gilt:
            //   ICMLCN enthält "Machine Learning", ist aber NICHT ICML.
            //   IFIP Networking 2026 IST IFIP Conference on Networking.
            const stats = tokenStats(item._identityTokens, identityTokens);
            if (
                item._identityTokens.size >= 2 &&
                stats.intersection >= 2 &&
                stats.coverage >= 0.85 &&
                stats.jaccard >= 0.60
            ) {
                const score = 1240 + Math.round(stats.coverage * 40 + stats.jaccard * 40);
                consider({
                    item,
                    score,
                    matchedBy: "identity-token-match",
                    venue: value,
                    origin,
                    tokenStats: stats
                });
            }
        }

        return best;
    }

    function bestCatalogMatch(items, variantValues, systemName, identityHint = null) {
        const variants = variantValues
            .map(value => typeof value === "string" ? { value, origin: "unknown" } : value)
            .filter(v => v?.value);

        const byIdentity = new Map();
        const eligibleItems = identityHint
            ? items.filter(item => itemMatchesIdentityHint(item, identityHint))
            : items;

        if (identityHint && eligibleItems.length === 0) {
            if (DEBUG) {
                console.debug(`[Scholar Venue Ranker] ${systemName}: Kein Katalogeintrag für sichere Identität`, identityHint);
            }
            return null;
        }

        for (const item of eligibleItems) {
            const candidate = evaluateRankingItem(item, variants, identityHint);
            if (!candidate) continue;

            const key = catalogIdentityKey(item);
            const group = byIdentity.get(key) || [];
            group.push(candidate);
            byIdentity.set(key, group);
        }

        const groups = [...byIdentity.entries()].map(([key, candidates]) => {
            candidates.sort((a, b) => b.score - a.score);
            return { key, best: candidates[0], candidates };
        }).sort((a, b) => b.best.score - a.best.score);

        if (!groups.length) return null;

        const top = groups[0];
        const second = groups[1];
        const score = top.best.score;

        // Unterhalb der konservativen Identitätsstufen gibt es in v13 überhaupt
        // keinen Match. "Bestes schlechtes Ergebnis" wird weiterhin nicht gewählt.
        if (score < 1240) return null;

        if (second) {
            const gap = score - second.best.score;
            const exactLike = score >= 1340;
            // Exakte/sicher vorab identifizierte Treffer benötigen nur Schutz
            // vor einem echten Gleichstand. Token-Matches brauchen Abstand.
            if (gap === 0 || (!exactLike && gap < 25)) {
                if (DEBUG) {
                    console.debug(`[Scholar Venue Ranker] ${systemName}: Mehrdeutige Venue-Identität`, {
                        first: top.best,
                        second: second.best
                    });
                }
                return null;
            }
        }

        // Doppelte Katalogzeilen derselben Venue mit widersprüchlichen Ranks
        // bleiben weiterhin ein Grund, gar nichts anzuzeigen.
        const topScoreCandidates = top.candidates.filter(c => c.score === top.best.score);
        const ranksAtTopScore = new Set(topScoreCandidates.map(c => String(c.item?.rank ?? "")));
        if (ranksAtTopScore.size > 1) {
            if (DEBUG) {
                console.debug(`[Scholar Venue Ranker] ${systemName}: Ranking-Konflikt für dieselbe Venue`, {
                    identity: top.key,
                    candidates: topScoreCandidates
                });
            }
            return null;
        }

        return top.best;
    }

    // ------------------------------------------------------------------
    // Scholar Cite: stiller Same-Origin-Abruf
    // ------------------------------------------------------------------
    //
    // WICHTIG: Wir klicken den Cite-Button NICHT mehr an. Ein Klick steuert
    // Scholars globales Cite-Modal über den URL-Hash. Dadurch kann das Modal
    // sichtbar aufblitzen und – noch schlimmer – beim nächsten Resultat kurz
    // den Inhalt des vorherigen Papers enthalten. Das führte in v8 zu
    // verschobenen Rankings (z.B. ICCAD -> RouteNet-Fermi, ToN -> Erlang).
    //
    // Stattdessen verwenden wir die stabile Scholar-Result-ID (data-cid),
    // rufen denselben output=cite-Endpunkt per fetch() ab und parsen die
    // Antwort in einem losgelösten DOMParser-Dokument. Die Seite, URL und
    // Modals werden dabei überhaupt nicht verändert.

    function hashString(value) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }

    function getScholarCid(pub) {
        const direct = String(pub?.dataset?.cid || pub?.getAttribute?.("data-cid") || "").trim();
        if (direct) return direct;

        // Defensive fallback: Manche Scholar-Varianten tragen die ID in einem
        // untergeordneten Element oder in einem Attribut mit dem info:-Link.
        const descendant = pub?.querySelector?.("[data-cid]");
        const nested = String(descendant?.dataset?.cid || "").trim();
        if (nested) return nested;

        const markup = String(pub?.outerHTML || "");
        const match = markup.match(/info(?::|%3A)([A-Za-z0-9_-]{6,})(?::|%3A)scholar\.google/i);
        return match ? match[1] : null;
    }

    function citationIdentity(cid, title, year) {
        return cid
            ? `cid:${cid}`
            : `${Number(year) || 0}|${normalize(title)}`;
    }

    function metadataIdentity(title, year) {
        return `${normalize(title)}|${Number(year) || 0}`;
    }

    function metadataCacheKey(title, year) {
        const identity = metadataIdentity(title, year);
        return `${METADATA_CACHE_PREFIX}${hashString(identity)}`;
    }

    function metadataMissKey(resolver, title, year) {
        const identity = metadataIdentity(title, year);
        return `${METADATA_MISS_PREFIX}${resolver}:${hashString(identity)}`;
    }

    async function getCachedCitation(cid, title, year) {
        try {
            const identity = citationIdentity(cid, title, year);
            const key = `${CITE_CACHE_PREFIX}${hashString(identity)}`;
            const stored = await chrome.storage.local.get(key);
            const cached = stored[key];

            if (
                cached?.identity === identity &&
                cached?.resolvedAt &&
                Date.now() - cached.resolvedAt < CITE_CACHE_TTL_MS
            ) {
                return { ...cached.result, source: "scholar-cite-cache" };
            }
        } catch (error) {
            if (DEBUG) console.debug("[SVR v14] Cite-Cache konnte nicht gelesen werden:", error);
        }
        return null;
    }

    async function getCachedMetadata(title, year) {
        try {
            const identity = metadataIdentity(title, year);
            const key = metadataCacheKey(title, year);
            const stored = await chrome.storage.local.get(key);
            const cached = stored[key];
            if (
                cached?.identity === identity &&
                cached?.timestamp &&
                Date.now() - cached.timestamp < METADATA_CACHE_TTL_MS &&
                cached?.result?.venue
            ) {
                return {
                    ...cached.result,
                    metadataSource: cached.result.source,
                    source: "metadata-cache"
                };
            }
        } catch (error) {
            if (DEBUG) console.debug("[SVR v14] Metadata-Cache konnte nicht gelesen werden:", error);
        }
        return null;
    }

    async function hasCachedResolverMiss(resolver, title, year) {
        try {
            const identity = metadataIdentity(title, year);
            const key = metadataMissKey(resolver, title, year);
            const stored = await chrome.storage.local.get(key);
            const cached = stored[key];
            return Boolean(
                cached?.identity === identity &&
                cached?.timestamp &&
                Date.now() - cached.timestamp < METADATA_MISS_TTL_MS
            );
        } catch (error) {
            if (DEBUG) console.debug(`[SVR v14] ${resolver}-Miss-Cache konnte nicht gelesen werden:`, error);
            return false;
        }
    }

    async function maintainLocalCaches() {
        const stored = await chrome.storage.local.get(null);
        const now = Date.now();
        const citeEntries = [];
        const metadataEntries = [];
        const keysToRemove = [];

        for (const [key, value] of Object.entries(stored)) {
            const timestamp = Number(value?.resolvedAt ?? value?.timestamp) || 0;
            if (key.startsWith(CITE_CACHE_ROOT_PREFIX)) {
                if (!timestamp || now - timestamp >= CITE_CACHE_TTL_MS) keysToRemove.push(key);
                else citeEntries.push({ key, timestamp });
            } else if (key.startsWith(METADATA_CACHE_PREFIX)) {
                if (!timestamp || now - timestamp >= METADATA_CACHE_TTL_MS) keysToRemove.push(key);
                else metadataEntries.push({ key, timestamp });
            } else if (key.startsWith(METADATA_MISS_PREFIX)) {
                if (!timestamp || now - timestamp >= METADATA_MISS_TTL_MS) keysToRemove.push(key);
            }
        }

        citeEntries.sort((a, b) => b.timestamp - a.timestamp);
        metadataEntries.sort((a, b) => b.timestamp - a.timestamp);
        keysToRemove.push(...citeEntries.slice(MAX_CITE_CACHE_ENTRIES).map(entry => entry.key));
        keysToRemove.push(...metadataEntries.slice(MAX_METADATA_CACHE_ENTRIES).map(entry => entry.key));

        if (keysToRemove.length) await chrome.storage.local.remove([...new Set(keysToRemove)]);
    }

    async function ensureLocalCachesMaintained() {
        if (!localCacheMaintenancePromise) {
            localCacheMaintenancePromise = maintainLocalCaches().catch(error => {
                if (DEBUG) console.debug("[SVR v14] Cache-Bereinigung fehlgeschlagen:", error);
            });
        }
        await localCacheMaintenancePromise;
    }

    async function cacheCitation(cid, title, year, result) {
        try {
            await ensureLocalCachesMaintained();
            const identity = citationIdentity(cid, title, year);
            const key = `${CITE_CACHE_PREFIX}${hashString(identity)}`;
            await chrome.storage.local.set({
                [key]: { identity, resolvedAt: Date.now(), result }
            });
            return true;
        } catch (error) {
            if (DEBUG) console.debug("[SVR v14] Cite-Ergebnis konnte nicht gecacht werden:", error);
            return false;
        }
    }

    async function cacheMetadata(title, year, result) {
        if (!result?.venue) return false;
        try {
            await ensureLocalCachesMaintained();
            const identity = metadataIdentity(title, year);
            const key = metadataCacheKey(title, year);
            await chrome.storage.local.set({
                [key]: {
                    identity,
                    title,
                    year: Number(year) || null,
                    timestamp: Date.now(),
                    result
                }
            });
            return true;
        } catch (error) {
            if (DEBUG) console.debug("[SVR v14] Metadata konnte nicht gecacht werden:", error);
            return false;
        }
    }

    async function cacheResolverMiss(resolver, title, year) {
        try {
            await ensureLocalCachesMaintained();
            const identity = metadataIdentity(title, year);
            const key = metadataMissKey(resolver, title, year);
            await chrome.storage.local.set({
                [key]: { identity, timestamp: Date.now() }
            });
        } catch (error) {
            if (DEBUG) console.debug(`[SVR v14] ${resolver}-Miss konnte nicht gecacht werden:`, error);
        }
    }

    function buildScholarCiteUrl(cid) {
        if (!cid) return null;

        const url = new URL("/scholar", window.location.origin);
        url.searchParams.set("q", `info:${cid}:scholar.google.com/`);
        url.searchParams.set("output", "cite");
        url.searchParams.set("scirp", "0");
        url.searchParams.set("hl", document.documentElement.lang || "en");
        return url.toString();
    }

    function looksLikeScholarBlockPage(text, responseUrl) {
        const haystack = `${responseUrl || ""}\n${text || ""}`.toLowerCase();
        return haystack.includes("/sorry/") ||
            haystack.includes("unusual traffic") ||
            haystack.includes("recaptcha") ||
            haystack.includes("not a robot");
    }

    async function fetchScholarCiteDocument(cid) {
        const url = buildScholarCiteUrl(cid);
        if (!url) throw new Error("CITE_CID_MISSING");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CITE_FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                method: "GET",
                credentials: "include",
                redirect: "follow",
                cache: "no-store",
                signal: controller.signal,
                headers: { "Accept": "text/html,application/xhtml+xml" }
            });

            const html = await response.text();

            if (response.status === 429 || looksLikeScholarBlockPage(html, response.url)) {
                citeLookupBlocked = true;
                throw new Error("SCHOLAR_RATE_LIMITED");
            }

            if (!response.ok) {
                throw new Error(`CITE_HTTP_${response.status}`);
            }

            const doc = new DOMParser().parseFromString(html, "text/html");
            if (!doc.querySelector(".gs_citr")) {
                throw new Error("CITE_ROWS_NOT_FOUND");
            }

            return doc;
        } finally {
            clearTimeout(timeout);
        }
    }

    function extractVenueFromCitationDocument(root, title) {
        if (!root) return null;

        const normalizedTitle = normalize(title);
        const citationRows = [...root.querySelectorAll(".gs_citr")];
        if (!citationRows.length) return null;

        const candidates = new Map();

        for (const row of citationRows) {
            for (const element of row.querySelectorAll("i, em")) {
                const value = String(element.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim();
                const normalizedValue = normalize(value);

                if (!normalizedValue || normalizedValue.length < 4) continue;
                if (normalizedValue === normalizedTitle) continue;

                // v12: "In <Container>" ist KEIN ausreichender Beweis für
                // eine Konferenz. Buchkapitel werden ebenfalls als "In ..."
                // zitiert; genau dadurch wurde "Deutsche Verfassungsgeschichte"
                // in v11 fälschlich als Conference klassifiziert.
                // Typen kommen nur aus dem Venue-Text selbst oder später aus
                // einer exakten Katalogidentität.
                const type = inferTypeFromText(value);

                const key = normalizedValue;
                const entry = candidates.get(key) || {
                    value,
                    normalized: normalizedValue,
                    count: 0,
                    conferenceVotes: 0,
                    journalVotes: 0
                };

                entry.count += 1;
                if (type === "conference") entry.conferenceVotes += 1;
                if (type === "journal") entry.journalVotes += 1;
                if (value.length > entry.value.length) entry.value = value;
                candidates.set(key, entry);
            }
        }

        if (!candidates.size) return null;

        const sorted = [...candidates.values()].sort((a, b) => {
            const aTyped = a.conferenceVotes + a.journalVotes;
            const bTyped = b.conferenceVotes + b.journalVotes;
            if (bTyped !== aTyped) return bTyped - aTyped;
            if (b.count !== a.count) return b.count - a.count;
            return b.normalized.length - a.normalized.length;
        });

        const best = sorted[0];
        let type = null;
        if (best.conferenceVotes > best.journalVotes) type = "conference";
        if (best.journalVotes > best.conferenceVotes) type = "journal";

        return { venue: best.value, type };
    }

    function structuredResolution(citeInfo, visibleVenue, title, rankings, source = "scholar-cite-fetch") {
        const venue = citeInfo?.venue;
        if (!venue) return null;

        if (detectSubvenue(title, venue) || detectSubvenue(title, visibleVenue)) {
            return { type: "subvenue", venue, source, typeConfidence: "strong", variants: [] };
        }

        // Eindeutige historische/alternative Vollnamen haben Vorrang.
        const alias = findDecisiveVenueAlias([venue, visibleVenue]);
        if (alias) {
            return aliasResolution(alias, visibleVenue, venue, source);
        }

        const explicitCiteType = citeInfo.type || inferTypeFromText(venue);
        const explicitVisibleType = inferTypeFromText(visibleVenue);
        const catalogType = exactCatalogType(venue, rankings);

        // Bei widersprüchlichen expliziten Typen lieber nichts anzeigen.
        if (explicitCiteType && explicitVisibleType && explicitCiteType !== explicitVisibleType) {
            if (DEBUG) {
                console.debug("[Scholar Venue Ranker] Widersprüchlicher Publication-Type", {
                    venue, visibleVenue, explicitCiteType, explicitVisibleType
                });
            }
            return null;
        }

        const type = explicitCiteType || explicitVisibleType || catalogType;
        if (!type) {
            // Bewusst kein Catch-all. Bücher, Reports und sonstige Container
            // bleiben unknown und werden nicht gegen CORE/CCF/SJR gematcht.
            return null;
        }

        return {
            type,
            venue,
            source,
            typeConfidence: explicitCiteType || explicitVisibleType ? "strong" : "catalog-exact",
            variants: [
                { value: venue, origin: source },
                { value: visibleVenue, origin: "visible" }
            ].filter(v => v.value)
        };
    }

    function summarizeAssessments(assessments) {
        return (Array.isArray(assessments) ? assessments : []).slice(0, 8).map(item => ({
            title: item?.candidate?.title || null,
            year: item?.candidate?.year || null,
            venue: item?.candidate?.venue || null,
            publicationType: item?.candidate?.publicationType || null,
            exactTitle: Boolean(item?.exactTitle),
            yearDistance: item?.yearDistance ?? null,
            authorOverlap: item?.authorOverlap ?? null,
            rejection: item?.rejection || null
        }));
    }

    function recordExternalRequest(resolver, response) {
        const requestId = String(response?.requestId || "");
        if (!requestId || countedResolverRequests.has(requestId)) return;
        countedResolverRequests.add(requestId);
        debugStats[`${resolver}Requests`] += 1;
    }

    function isCacheableResolverMiss(reason) {
        return [
            "no-high-confidence-candidate",
            "ambiguous-candidates",
            "near-year-not-unique",
            "venue-or-type-not-safe"
        ].includes(String(reason || ""));
    }

    async function resolveViaExternalMetadata(resolver, paper, visibleVenue, rankings, trace) {
        const cachedMiss = await hasCachedResolverMiss(resolver, paper.title, paper.year);
        trace[`${resolver}NegativeCacheHit`] = cachedMiss;
        if (cachedMiss) {
            if (DEBUG) console.debug(`[SVR v14] ${resolver}: negativer Cache-Treffer`, paper);
            return null;
        }

        trace[`${resolver}LookupStarted`] = true;
        let response;
        try {
            response = await chrome.runtime.sendMessage({
                action: "resolveMetadata",
                resolver,
                paper
            });
        } catch (error) {
            response = { resolved: false, source: resolver, reason: String(error?.message || error) };
        }

        recordExternalRequest(resolver, response);
        trace[`${resolver}Result`] = {
            resolved: Boolean(response?.resolved),
            reason: response?.reason || null,
            confidence: response?.confidence || null,
            venue: response?.venue || null,
            year: response?.year || null,
            publicationType: response?.publicationType || null
        };

        if (DEBUG) {
            console.debug(`[SVR v14] ${resolver} Kandidatenbewertung`, {
                paper,
                result: trace[`${resolver}Result`],
                candidates: summarizeAssessments(response?.assessments)
            });
        }

        if (!response?.resolved || !response?.venue) {
            if (isCacheableResolverMiss(response?.reason)) {
                await cacheResolverMiss(resolver, paper.title, paper.year);
            }
            return null;
        }

        const resolution = structuredResolution(
            { venue: response.venue, type: response.publicationType },
            visibleVenue,
            paper.title,
            rankings,
            resolver
        );

        if (!resolution) {
            trace[`${resolver}Result`].reason = "venue-or-type-not-safe";
            await cacheResolverMiss(resolver, paper.title, paper.year);
            return null;
        }

        debugStats[`${resolver}Resolutions`] += 1;
        await cacheMetadata(paper.title, paper.year, resolution);
        return resolution;
    }

    async function resolveViaScholarCite(pub, title, year, visibleVenue, rankings) {
        const cid = getScholarCid(pub);
        if (!cid) {
            if (DEBUG) {
                console.debug("[Scholar Venue Ranker] Kein data-cid für Cite-Auflösung:", {
                    title, year, visibleVenue
                });
            }
            return null;
        }

        const cached = await getCachedCitation(cid, title, year);
        if (cached) return cached;

        if (citeLookupBlocked || citeLookupsThisPage >= MAX_CITE_LOOKUPS_PER_PAGE) {
            return null;
        }

        citeLookupsThisPage += 1;
        debugStats.citeRequests += 1;

        try {
            const doc = await fetchScholarCiteDocument(cid);
            const citeInfo = extractVenueFromCitationDocument(doc, title);
            if (!citeInfo?.venue) throw new Error("CITE_VENUE_NOT_FOUND");

            const resolution = structuredResolution(
                citeInfo,
                visibleVenue,
                title,
                rankings,
                "scholar-cite-fetch"
            );

            if (!resolution) {
                if (DEBUG) {
                    console.debug("[Scholar Venue Ranker] Cite-Venue ohne sicheren Typ:", {
                        title, year, cid, venue: citeInfo.venue, citeType: citeInfo.type
                    });
                }
                return null;
            }

            await cacheCitation(cid, title, year, resolution);
            return resolution;
        } catch (error) {
            if (DEBUG) {
                console.debug("[Scholar Venue Ranker] Stille Scholar-Cite-Auflösung fehlgeschlagen:", {
                    title,
                    year,
                    cid,
                    error: String(error?.name === "AbortError" ? "CITE_FETCH_TIMEOUT" : (error?.message || error))
                });
            }
            return null;
        } finally {
            await sleep(CITE_DELAY_MS);
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ------------------------------------------------------------------
    // Darstellung
    // ------------------------------------------------------------------

    function createBadge(text, background, foreground = "white") {
        const badge = document.createElement("span");
        badge.textContent = `[${text}]`;
        Object.assign(badge.style, {
            backgroundColor: background,
            color: foreground,
            padding: "2px 6px",
            marginLeft: "6px",
            borderRadius: "4px",
            fontSize: "11px",
            fontWeight: "bold",
            verticalAlign: "middle",
            display: "inline-block",
            boxShadow: "0 1px 2px rgba(0,0,0,0.2)"
        });
        return badge;
    }

    function badgeColorsFor(system, rank) {
        const normalizedSystem = String(system || "").trim().toUpperCase();
        const normalizedRank = String(rank || "").trim().toUpperCase();
        return BADGE_COLORS[normalizedSystem]?.[normalizedRank] || NEUTRAL_BADGE_COLOR;
    }

    function appendRank(container, system, candidate, resolution) {
        if (!candidate) {
            if (SHOW_NOT_FOUND) {
                container.appendChild(createBadge(
                    `${system}: 404`,
                    NEUTRAL_BADGE_COLOR.background,
                    NEUTRAL_BADGE_COLOR.text
                ));
            }
            return;
        }

        const rawRank = candidate.item?.rank;
        const rank = rawRank == null ? "" : String(rawRank).trim();
        const lower = rank.toLowerCase();
        const unranked = ["", "unranked", "national", "none", "-"].includes(lower);
        const colors = badgeColorsFor(system, unranked ? "" : rank);

        const badge = unranked
            ? createBadge(`${system}: -`, colors.background, colors.text)
            : createBadge(`${system}: ${rank}`, colors.background, colors.text);

        if (DEBUG) {
            badge.title = [
                `Venue: ${resolution.venue}`,
                `Type: ${resolution.type}`,
                `Source: ${resolution.source}`,
                `Matched: ${candidate.item?.name || candidate.item?.abbr || "-"}`,
                `Abbr: ${candidate.item?.abbr || "-"}`,
                `Match: ${candidate.matchedBy}`,
                `Evidence score: ${candidate.score}`
            ].join("\n");
        }

        container.appendChild(badge);
    }

    function renderRanks(titleElement, resolution, title, rankings, options = {}) {
        const pageType = options.pageType || "search";
        const badgePlacement = options.badgePlacement || "append";
        const badgeRoot = badgePlacement === "after-title"
            ? titleElement.parentElement
            : titleElement;
        const existing = badgeRoot?.querySelector(".scholar-ranking-badges");
        if (existing) existing.remove();

        if (!resolution || resolution.type === "unknown" || resolution.type === "subvenue") return;
        if (detectSubvenue(title, resolution.venue)) return;

        const variants = resolution.variants?.length
            ? resolution.variants
            : [{ value: resolution.venue, origin: "unknown" }];

        let core = null;
        let ccf = null;
        let sjr = null;

        if (resolution.type === "conference") {
            core = bestCatalogMatch(rankings.core, variants, "CORE", resolution.identityHint);
            ccf = bestCatalogMatch(rankings.ccfConferences, variants, "CCF", resolution.identityHint);
        } else if (resolution.type === "journal") {
            ccf = bestCatalogMatch(rankings.ccfJournals, variants, "CCF", resolution.identityHint);
            sjr = bestCatalogMatch(rankings.sjr, variants, "SJR", resolution.identityHint);
        }

        if (DEBUG) {
            const summarize = candidate => candidate ? {
                rank: candidate.item?.rank ?? null,
                name: candidate.item?.name ?? null,
                abbr: candidate.item?.abbr ?? null,
                matchedBy: candidate.matchedBy ?? null,
                score: candidate.score ?? null,
                venue: candidate.venue ?? null,
                origin: candidate.origin ?? null,
                coreName: candidate.coreName ?? null
            } : null;

            const label = pageType === "profile" ? "[SVR v14 PROFILE MATCH]" : "[SVR v14 MATCH]";
            console.debug(label, {
                pageType,
                title,
                resolution,
                summary: {
                    CORE: summarize(core),
                    CCF: summarize(ccf),
                    SJR: summarize(sjr)
                },
                selectedRankings: { CORE: core, CCF: ccf, SJR: sjr }
            });
        }

        const container = document.createElement("span");
        container.className = "scholar-ranking-badges";
        container.style.display = "inline-block";
        container.style.marginLeft = "4px";

        appendRank(container, "CORE", core, resolution);
        appendRank(container, "CCF", ccf, resolution);
        appendRank(container, "SJR", sjr, resolution);

        if (!container.hasChildNodes()) return;
        if (badgePlacement === "after-title" && titleElement.insertAdjacentElement) {
            titleElement.insertAdjacentElement("afterend", container);
        } else {
            titleElement.appendChild(container);
        }
    }

    // ------------------------------------------------------------------
    // Hauptablauf
    // ------------------------------------------------------------------

    function logFinalResolution(context, resolution) {
        if (!DEBUG) return;
        console.debug("[SVR v14 RESOLUTION]", {
            pageType: context.pageType,
            title: context.title,
            scholarVenue: context.meta.venue,
            scholarVenueRaw: context.meta.rawVenue,
            year: context.meta.year,
            trace: context.trace,
            finalResolution: resolution,
            requestStats: { ...debugStats }
        });
    }

    function finalizePublication(context, resolution) {
        if (context.dwellTimer) {
            clearTimeout(context.dwellTimer);
            context.dwellTimer = null;
        }
        if (citeObserver) citeObserver.unobserve(context.pub);
        if (profileObserver) profileObserver.unobserve(context.pub);
        renderRanks(context.titleElement, resolution, context.title, context.rankings, {
            pageType: context.pageType,
            badgePlacement: context.badgePlacement
        });
        context.pub.dataset.svrState = "done";
        context.resolution = resolution;
        logFinalResolution(context, resolution);
    }

    function enqueueScholarCite(context) {
        if (context.citeQueued || context.pub.dataset.svrState === "done") return;
        if (context.pageType === "profile") {
            context.trace.citeSkipped = "disabled-on-profile";
            finalizePublication(context, null);
            return;
        }
        if (citeLookupBlocked || citeLookupsThisPage >= MAX_CITE_LOOKUPS_PER_PAGE) {
            context.trace.citeSkipped = citeLookupBlocked ? "blocked" : "page-limit";
            if (DEBUG) {
                console.debug("[SVR v14] Scholar Cite übersprungen", {
                    title: context.title,
                    reason: context.trace.citeSkipped,
                    citeLookupsThisPage
                });
            }
            finalizePublication(context, null);
            return;
        }

        context.citeQueued = true;
        context.pub.dataset.svrState = "cite-queued";

        const run = citeQueueTail.catch(() => undefined).then(async () => {
            context.citeQueued = false;
            if (context.pub.dataset.svrState === "done") return;

            // Schnelles Scrollen kann den Eintrag aus dem Viewport entfernen,
            // während er noch hinter einem anderen Cite-Request wartet.
            if (!context.visible) {
                context.pub.dataset.svrState = "waiting-for-cite";
                return;
            }

            if (citeLookupBlocked || citeLookupsThisPage >= MAX_CITE_LOOKUPS_PER_PAGE) {
                context.trace.citeSkipped = citeLookupBlocked ? "blocked" : "page-limit";
                finalizePublication(context, null);
                return;
            }

            context.pub.dataset.svrState = "cite-resolving";
            context.trace.citeStartedFromViewport = true;
            const resolution = await resolveViaScholarCite(
                context.pub,
                context.title,
                context.meta.year,
                context.meta.rawVenue,
                context.rankings
            );

            if (resolution) {
                debugStats.citeResolutions += 1;
                await cacheMetadata(context.title, context.meta.year, resolution);
            }
            finalizePublication(context, resolution);
        }).catch(error => {
            context.trace.citeError = String(error?.message || error);
            finalizePublication(context, null);
        });

        citeQueueTail = run.catch(() => undefined);
    }

    function startCiteDwellTimer(context) {
        if (context.dwellTimer || context.citeQueued || context.pub.dataset.svrState === "done") return;
        context.dwellTimer = setTimeout(() => {
            context.dwellTimer = null;
            if (context.visible && context.pub.dataset.svrState === "waiting-for-cite") {
                enqueueScholarCite(context);
            }
        }, CITE_DWELL_MS);
    }

    function ensureCiteObserver() {
        if (citeObserver) return citeObserver;
        if (typeof IntersectionObserver !== "function") return null;

        citeObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const context = citeContexts.get(entry.target);
                if (!context || entry.target.dataset.svrState === "done") continue;

                context.visible = entry.isIntersecting && entry.intersectionRatio >= 0.25;
                if (context.visible) {
                    startCiteDwellTimer(context);
                } else if (context.dwellTimer) {
                    clearTimeout(context.dwellTimer);
                    context.dwellTimer = null;
                }
            }
        }, { threshold: [0.25] });

        return citeObserver;
    }

    function waitForLazyScholarCite(context) {
        const observer = ensureCiteObserver();
        if (!observer || !getScholarCid(context.pub)) {
            context.trace.citeSkipped = observer ? "cid-missing" : "intersection-observer-unavailable";
            finalizePublication(context, null);
            return;
        }

        context.pub.dataset.svrState = "waiting-for-cite";
        context.trace.citeNecessary = true;
        citeContexts.set(context.pub, context);
        observer.observe(context.pub);
    }

    async function resolveContextExternally(context) {
        const paper = {
            title: context.title,
            year: context.meta.year,
            authors: context.meta.authors
        };

        for (const resolver of EXTERNAL_RESOLVER_ORDER) {
            const resolution = await resolveViaExternalMetadata(
                resolver,
                paper,
                context.meta.rawVenue,
                context.rankings,
                context.trace
            );
            if (resolution) return resolution;
        }
        return null;
    }

    async function resolveProfileContext(context) {
        if (context.pub.dataset.svrState === "done") return;
        context.pub.dataset.svrState = "profile-resolving";
        try {
            const resolution = await resolveContextExternally(context);
            if (resolution) debugStats.profileExternalResolutions += 1;
            finalizePublication(context, resolution);
        } catch (error) {
            context.trace.pipelineError = String(error?.message || error);
            finalizePublication(context, null);
        }
    }

    function ensureProfileObserver() {
        if (profileObserver) return profileObserver;
        if (typeof IntersectionObserver !== "function") return null;

        profileObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const context = profileContexts.get(entry.target);
                if (!context || entry.target.dataset.svrState !== "waiting-for-profile-viewport") continue;
                if (!entry.isIntersecting) continue;

                profileObserver.unobserve(entry.target);
                resolveProfileContext(context);
            }
        }, {
            rootMargin: "400px 0px",
            threshold: [0.01]
        });
        return profileObserver;
    }

    function waitForLazyProfileResolution(context) {
        const observer = ensureProfileObserver();
        if (!observer) {
            context.trace.profileExternalSkipped = "intersection-observer-unavailable";
            finalizePublication(context, null);
            return;
        }

        context.pub.dataset.svrState = "waiting-for-profile-viewport";
        context.trace.profileWaitingForViewport = true;
        profileContexts.set(context.pub, context);
        debugStats.profileRowsObserved += 1;
        observer.observe(context.pub);
    }

    async function processPublication(pub, rankings, pageType = "search") {
        if (pub.dataset.svrState) return;
        pub.dataset.svrState = "pending";
        if (pageType === "profile") debugStats.profileRowsDetected += 1;

        const paperMetadata = extractPaperMetadata(pub, pageType);
        if (!paperMetadata) {
            pub.dataset.svrState = "done";
            return;
        }

        const { titleElement, title, meta, badgePlacement } = paperMetadata;

        const trace = {
            pageType,
            visibleResolved: false,
            metadataCache: "miss",
            legacyCiteCache: "miss",
            dblpLookupStarted: false,
            crossrefLookupStarted: false,
            citeNecessary: false,
            citeStartedFromViewport: false
        };
        const context = {
            pub,
            pageType,
            rankings,
            titleElement,
            badgePlacement,
            title,
            meta,
            trace,
            visible: false,
            dwellTimer: null,
            citeQueued: false,
            resolution: null
        };

        try {
            pub.dataset.svrState = "resolving";
            let resolution = highConfidenceVisibleResolution(meta, title, rankings);
            if (resolution) {
                trace.visibleResolved = true;
                debugStats.visibleResolutions += 1;
                finalizePublication(context, resolution);
                return;
            }

            resolution = await getCachedMetadata(title, meta.year);
            if (resolution) {
                trace.metadataCache = "hit";
                debugStats.metadataCacheHits += 1;
                finalizePublication(context, resolution);
                return;
            }

            if (pageType === "profile") {
                waitForLazyProfileResolution(context);
                return;
            }

            // Der vorhandene CID-Cache zählt als lokaler Metadata-Cache und wird
            // vor externen APIs geprüft, damit alte Treffer keine neuen Requests
            // verursachen. Sein Prefix bleibt bewusst unverändert.
            const cid = getScholarCid(pub);
            resolution = await getCachedCitation(cid, title, meta.year);
            if (resolution) {
                trace.legacyCiteCache = "hit";
                debugStats.metadataCacheHits += 1;
                await cacheMetadata(title, meta.year, resolution);
                finalizePublication(context, resolution);
                return;
            }

            resolution = await resolveContextExternally(context);

            if (resolution) {
                finalizePublication(context, resolution);
                return;
            }

            waitForLazyScholarCite(context);
        } catch (error) {
            trace.pipelineError = String(error?.message || error);
            finalizePublication(context, null);
        }
    }

    async function processResults(rankings, pageType = "search") {
        const publications = [...document.querySelectorAll(publicationSelector(pageType))];
        let nextIndex = 0;

        async function worker() {
            while (nextIndex < publications.length) {
                const pub = publications[nextIndex];
                nextIndex += 1;
                await processPublication(pub, rankings, pageType);
            }
        }

        const workerCount = Math.min(RESULT_WORKER_COUNT, publications.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    function observeDynamicResults(rankings, pageType = "search") {
        if (typeof MutationObserver !== "function") return;
        const rowSelector = pageType === "profile" ? ".gsc_a_tr" : ".gs_r.gs_or.gs_scl";
        const observer = new MutationObserver(mutations => {
            const publications = new Set();
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    if (node.matches(rowSelector)) publications.add(node);
                    for (const pub of node.querySelectorAll(rowSelector)) publications.add(pub);
                }
            }
            for (const pub of publications) processPublication(pub, rankings, pageType);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (globalThis.__SVR_ENABLE_TEST_HOOKS__) {
        globalThis.__SVR_TEST_HOOKS__ = {
            appendRank,
            badgeColorsFor,
            bestCatalogMatch,
            cacheCitation,
            cacheMetadata,
            debugStats,
            detectPageType,
            detectSubvenue,
            evaluateRankingItem,
            extractMeta,
            extractPaperMetadata,
            extractProfilePaper,
            getCachedMetadata,
            hasCachedResolverMiss,
            maintainLocalCaches,
            metadataCacheKey,
            metadataIdentity,
            metadataMissKey,
            normalize,
            observeDynamicResults,
            prepareItem,
            processPublication,
            processResults,
            renderRanks,
            isCacheableResolverMiss,
            shortAcronymWithCoreSupport,
            structuredResolution,
            config: {
                citeCachePrefix: CITE_CACHE_PREFIX,
                citeDelayMs: CITE_DELAY_MS,
                citeDwellMs: CITE_DWELL_MS,
                maxCiteLookupsPerPage: MAX_CITE_LOOKUPS_PER_PAGE,
                metadataCacheTtlMs: METADATA_CACHE_TTL_MS,
                metadataMissTtlMs: METADATA_MISS_TTL_MS,
                resolverOrder: [...EXTERNAL_RESOLVER_ORDER]
            }
        };
    }
})();
