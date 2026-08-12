(() => {
    "use strict";

    const SHOW_NOT_FOUND = false;
    const DEBUG = false;

    const CITE_CACHE_ROOT_PREFIX = "scholarCite:";
    const CITE_CACHE_PREFIX = `${CITE_CACHE_ROOT_PREFIX}v13-debug:`;
    const CITE_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
    const MAX_CITE_CACHE_ENTRIES = 500;
    const CITE_FETCH_TIMEOUT_MS = 6500;
    const CITE_DELAY_MS = 350;
    const MAX_CITE_LOOKUPS_PER_PAGE = 12;

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
    let citeCacheMaintenancePromise = null;

    console.info("[Scholar Venue Ranker] v13.2-debug geladen – Organisationskürzel werden nicht mehr als eigenständige Venue-Akronyme gewertet.");

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
        await processResults(rankings);
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
            truncated: /\u2026|\.\.\./.test(rawVenue)
        };
    }

    function detectSubvenue(title, venue) {
        const normalizedVenue = normalize(venue);
        for (const signal of SUBVENUE_SIGNALS) {
            if (containsWordPhrase(normalizedVenue, signal)) return signal;
        }

        // Der Titel allein ist nur dann belastbar, wenn Scholar ihn sichtbar als
        // Beitragstyp labelt (z.B. "Demo: ..." oder "[Poster] ..."). Normale
        // Paper wie "Demonstration of ..." dürfen nicht herausgefiltert werden.
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

    async function getCachedCitation(cid, title, year) {
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
        return null;
    }

    async function maintainCitationCache() {
        const stored = await chrome.storage.local.get(null);
        const now = Date.now();
        const entries = Object.entries(stored)
            .filter(([key]) => key.startsWith(CITE_CACHE_ROOT_PREFIX))
            .map(([key, value]) => ({
                key,
                resolvedAt: Number(value?.resolvedAt) || 0
            }))
            .sort((a, b) => b.resolvedAt - a.resolvedAt);

        const keysToRemove = entries
            .filter((entry, index) =>
                !entry.resolvedAt ||
                now - entry.resolvedAt >= CITE_CACHE_TTL_MS ||
                index >= MAX_CITE_CACHE_ENTRIES
            )
            .map(entry => entry.key);

        if (keysToRemove.length) {
            await chrome.storage.local.remove(keysToRemove);
        }
    }

    async function ensureCitationCacheMaintained() {
        if (!citeCacheMaintenancePromise) {
            citeCacheMaintenancePromise = maintainCitationCache().catch(error => {
                if (DEBUG) {
                    console.debug("[Scholar Venue Ranker] Cite-Cache-Bereinigung fehlgeschlagen:", error);
                }
            });
        }
        await citeCacheMaintenancePromise;
    }

    async function cacheCitation(cid, title, year, result) {
        try {
            await ensureCitationCacheMaintained();

            const identity = citationIdentity(cid, title, year);
            const key = `${CITE_CACHE_PREFIX}${hashString(identity)}`;
            await chrome.storage.local.set({
                [key]: { identity, resolvedAt: Date.now(), result }
            });
            return true;
        } catch (error) {
            // Der Cache ist eine Optimierung. Quoten-/Storage-Fehler dürfen eine
            // bereits erfolgreiche Venue-Auflösung niemals verwerfen.
            if (DEBUG) {
                console.debug("[Scholar Venue Ranker] Cite-Ergebnis konnte nicht gecacht werden:", error);
            }
            return false;
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
                { value: venue, origin: "cite" },
                { value: visibleVenue, origin: "visible" }
            ].filter(v => v.value)
        };
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

    function appendRank(container, system, candidate, color, resolution) {
        if (!candidate) {
            if (SHOW_NOT_FOUND) {
                container.appendChild(createBadge(`${system}: 404`, "#e0e0e0", "#555"));
            }
            return;
        }

        const rawRank = candidate.item?.rank;
        const rank = rawRank == null ? "" : String(rawRank).trim();
        const lower = rank.toLowerCase();
        const unranked = ["", "unranked", "national", "none", "-"].includes(lower);

        const badge = unranked
            ? createBadge(`${system}: -`, "#9e9e9e")
            : createBadge(`${system}: ${rank}`, color);

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

    function renderRanks(titleElement, resolution, title, rankings) {
        const existing = titleElement.querySelector(".scholar-ranking-badges");
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

            console.debug("[SVR v13.2 MATCH]", {
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

        appendRank(container, "CORE", core, "#4CAF50", resolution);
        appendRank(container, "CCF", ccf, "#2196F3", resolution);
        appendRank(container, "SJR", sjr, "#FF9800", resolution);

        if (container.hasChildNodes()) titleElement.appendChild(container);
    }

    // ------------------------------------------------------------------
    // Hauptablauf
    // ------------------------------------------------------------------

    async function processPublication(pub, rankings) {
        if (pub.dataset.svrState === "processing" || pub.dataset.svrState === "done") return;
        pub.dataset.svrState = "processing";

        const titleElement = pub.querySelector(".gs_rt");
        const metaElement = pub.querySelector(".gs_a");
        if (!titleElement || !metaElement) {
            pub.dataset.svrState = "done";
            return;
        }

        const title = cleanTitle(titleElement.textContent);
        const meta = extractMeta(metaElement.textContent);
        if (!title || !meta?.venue) {
            pub.dataset.svrState = "done";
            return;
        }

        let resolution = highConfidenceVisibleResolution(meta, title, rankings);

        if (!resolution && !detectSubvenue(title, meta.rawVenue)) {
            resolution = await resolveViaScholarCite(pub, title, meta.year, meta.rawVenue, rankings);
        }

        if (!resolution && detectSubvenue(title, meta.rawVenue)) {
            resolution = {
                type: "subvenue",
                venue: meta.venue,
                source: "scholar-visible",
                variants: []
            };
        }

        renderRanks(titleElement, resolution, title, rankings);
        pub.dataset.svrState = "done";

        if (DEBUG) {
            console.debug("[Scholar Venue Ranker]", {
                title,
                year: meta.year,
                scholarVenue: meta.venue,
                scholarVenueRaw: meta.rawVenue,
                truncated: meta.truncated,
                resolution
            });
        }
    }

    async function processResults(rankings) {
        const publications = [...document.querySelectorAll(".gs_r.gs_or.gs_scl")];
        // Absichtlich sequenziell: weniger Scholar-Requests gleichzeitig und
        // deterministische Zuordnung von Resultat -> Cite-Antwort.
        for (const pub of publications) {
            await processPublication(pub, rankings);
        }
    }

    // Kleine, explizit aktivierte Testoberfläche; im Content Script bleibt sie
    // standardmäßig vollständig inaktiv.
    if (globalThis.__SVR_ENABLE_TEST_HOOKS__) {
        globalThis.__SVR_TEST_HOOKS__ = {
            detectSubvenue,
            cacheCitation,
            maintainCitationCache
        };
    }
})();
