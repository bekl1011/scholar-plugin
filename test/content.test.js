const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
    path.join(__dirname, "..", "content.js"),
    "utf8"
);

function createMemoryStorage(seed = {}) {
    const data = { ...seed };
    return {
        data,
        async get(keys) {
            if (keys == null) return { ...data };
            if (typeof keys === "string") return { [keys]: data[keys] };
            if (Array.isArray(keys)) {
                return Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]));
            }
            return {};
        },
        async set(values) { Object.assign(data, values); },
        async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        }
    };
}

function loadContentHooks(storageOverrides = {}, contextOverrides = {}) {
    const memory = createMemoryStorage();
    const storage = { ...memory, ...storageOverrides };
    const context = {
        AbortController,
        URL,
        URLSearchParams,
        chrome: {
            runtime: { async sendMessage() {} },
            storage: { local: storage }
        },
        console: {
            debug() {},
            error() {},
            info() {},
            warn() {}
        },
        document: {
            body: {},
            documentElement: { lang: "en" },
            querySelectorAll() { return []; }
        },
        setTimeout,
        clearTimeout,
        window: { location: { origin: "https://scholar.google.com" } },
        __SVR_ENABLE_TEST_HOOKS__: true,
        ...contextOverrides
    };

    vm.runInNewContext(contentScript, context, { filename: "content.js" });
    return { context, hooks: context.__SVR_TEST_HOOKS__, storage };
}

function catalogMatch(hooks, name, abbr, venue, type = "conference") {
    const item = hooks.prepareItem({ name, abbr, rank: "A" }, type, "TEST");
    return hooks.bestCatalogMatch(
        [item],
        [{ value: venue, origin: "test" }],
        "TEST"
    );
}

class FakeElement {
    constructor(textContent = "") {
        this.textContent = textContent;
        this.dataset = {};
        this.style = {};
        this.children = [];
        this.parentElement = null;
        this.className = "";
        this.badge = null;
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    hasChildNodes() { return this.children.length > 0; }

    insertAdjacentElement(_position, element) {
        if (this.parentElement) this.parentElement.badge = element;
        element.parentElement = this.parentElement;
        return element;
    }

    querySelector(selector) {
        if (selector === ".scholar-ranking-badges") return this.badge;
        return null;
    }

    querySelectorAll() { return []; }

    remove() {
        if (this.parentElement?.badge === this) this.parentElement.badge = null;
    }
}

function makeProfileRow({ title, authors = "", venue = "", year = "" }) {
    const row = new FakeElement();
    const titleElement = new FakeElement(title);
    const cell = new FakeElement();
    const grayLines = [new FakeElement(authors), new FakeElement(venue)];
    const yearElement = new FakeElement(String(year));
    titleElement.parentElement = cell;
    cell.querySelectorAll = selector => selector === ".gs_gray" ? grayLines : [];
    cell.querySelector = selector => selector === ".scholar-ranking-badges" ? cell.badge : null;
    row.querySelector = selector => {
        if (selector === ".gsc_a_at") return titleElement;
        if (selector === ".gsc_a_t") return cell;
        if (selector === ".gsc_a_y .gsc_a_h, .gsc_a_y span") return yearElement;
        return null;
    };
    row.querySelectorAll = () => [];
    row.matches = selector => selector === ".gsc_a_tr";
    return { cell, row, titleElement };
}

class MockIntersectionObserver {
    static instances = [];

    constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = new Set();
        MockIntersectionObserver.instances.push(this);
    }

    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }

    trigger(target, isIntersecting = true, intersectionRatio = 1) {
        this.callback([{ target, isIntersecting, intersectionRatio }]);
    }
}

class MockMutationObserver {
    static instances = [];

    constructor(callback) {
        this.callback = callback;
        this.target = null;
        MockMutationObserver.instances.push(this);
    }

    observe(target) { this.target = target; }

    trigger(addedNodes) {
        this.callback([{ addedNodes }]);
    }
}

function profileTestEnvironment() {
    MockIntersectionObserver.instances = [];
    MockMutationObserver.instances = [];
    const document = {
        body: new FakeElement(),
        createElement() { return new FakeElement(); },
        documentElement: { lang: "en" },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    const loaded = loadContentHooks({}, {
        document,
        Element: FakeElement,
        IntersectionObserver: MockIntersectionObserver,
        MutationObserver: MockMutationObserver
    });
    return { ...loaded, document };
}

function preparedRankings(hooks) {
    return {
        core: [
            hooks.prepareItem({ name: "IEEE International Conference on Computer Communications", abbr: "INFOCOM", rank: "A*" }, "conference", "CORE"),
            hooks.prepareItem({ name: "ACM SIGOPS Symposium on Operating Systems Principles", abbr: "SOSP", rank: "A*" }, "conference", "CORE"),
            hooks.prepareItem({ name: "IEEE Vehicular Technology Conference", abbr: "VTC", rank: "B" }, "conference", "CORE")
        ],
        ccfConferences: [
            hooks.prepareItem({ name: "IEEE International Conference on Computer Communications", abbr: "INFOCOM", rank: "A" }, "conference", "CCF"),
            hooks.prepareItem({ name: "ACM SIGOPS Symposium on Operating Systems Principles", abbr: "SOSP", rank: "A" }, "conference", "CCF")
        ],
        sjr: [
            hooks.prepareItem({ name: "IEEE/ACM Transactions on Networking", abbr: "TON", rank: "Q1" }, "journal", "SJR")
        ],
        ccfJournals: [
            hooks.prepareItem({ name: "IEEE/ACM Transactions on Networking", abbr: "TON", rank: "A" }, "journal", "CCF")
        ]
    };
}

function badgeTexts(cell) {
    return cell.badge ? cell.badge.children.map(child => child.textContent) : [];
}

function badgeStyles(container) {
    return container.children.map(child => ({
        text: child.textContent,
        background: child.style.backgroundColor,
        color: child.style.color
    }));
}

async function flushAsyncWork() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

test("ranking systems and ranks map to the exact central badge palette", () => {
    const { hooks } = loadContentHooks();
    const expected = {
        CORE: {
            "A*": { background: "#2D6A4F", text: "#FFFFFF" },
            A: { background: "#B7E4C7", text: "#12351F" },
            B: { background: "#F4D35E", text: "#3B2F00" },
            C: { background: "#B23A48", text: "#FFFFFF" }
        },
        CCF: {
            A: { background: "#0057B8", text: "#FFFFFF" },
            B: { background: "#5AA6E0", text: "#0B2239" },
            C: { background: "#B9DCF5", text: "#12324A" }
        },
        SJR: {
            Q1: { background: "#5B148C", text: "#FFFFFF" },
            Q2: { background: "#9146B8", text: "#FFFFFF" },
            Q3: { background: "#C68AD9", text: "#2B1833" },
            Q4: { background: "#E4D8E8", text: "#3A2C40" }
        }
    };

    for (const [system, ranks] of Object.entries(expected)) {
        for (const [rank, colors] of Object.entries(ranks)) {
            assert.deepEqual({ ...hooks.badgeColorsFor(system, rank) }, colors, `${system} ${rank}`);
        }
    }

    assert.notDeepEqual(
        { ...hooks.badgeColorsFor("CORE", "A") },
        { ...hooks.badgeColorsFor("CCF", "A") }
    );
    assert.notDeepEqual(
        { ...hooks.badgeColorsFor("CCF", "A") },
        { ...hooks.badgeColorsFor("SJR", "Q1") }
    );
});

test("unknown ranks use the neutral fallback without changing badge text", () => {
    const { hooks } = profileTestEnvironment();
    const container = new FakeElement();
    hooks.appendRank(container, "CORE", {
        item: { name: "Future Venue", abbr: "FV", rank: "S" },
        matchedBy: "test",
        score: 100
    }, {
        venue: "Future Venue",
        type: "conference",
        source: "test"
    });

    assert.deepEqual(badgeStyles(container), [{
        text: "[CORE: S]",
        background: "#E5E7EB",
        color: "#374151"
    }]);
});

test("search and profile rendering use identical badge colors", () => {
    const { hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    const resolution = {
        type: "conference",
        venue: "INFOCOM",
        source: "test",
        variants: [{ value: "INFOCOM", origin: "test" }]
    };

    const searchTitle = new FakeElement("A Paper");
    hooks.renderRanks(searchTitle, resolution, "A Paper", rankings, {
        pageType: "search",
        badgePlacement: "append"
    });

    const profileCell = new FakeElement();
    const profileTitle = new FakeElement("A Paper");
    profileTitle.parentElement = profileCell;
    hooks.renderRanks(profileTitle, resolution, "A Paper", rankings, {
        pageType: "profile",
        badgePlacement: "after-title"
    });

    assert.deepEqual(
        badgeStyles(searchTitle.children[0]),
        badgeStyles(profileCell.badge)
    );
    assert.deepEqual(badgeStyles(profileCell.badge), [
        { text: "[CORE: A*]", background: "#2D6A4F", color: "#FFFFFF" },
        { text: "[CCF: A]", background: "#0057B8", color: "#FFFFFF" }
    ]);
});

test("ordinary paper titles are not treated as subvenues", () => {
    const { hooks } = loadContentHooks();
    assert.equal(
        hooks.detectSubvenue(
            "Demonstration of a scalable routing algorithm",
            "Journal of Network and Systems Management"
        ),
        null
    );
    assert.equal(
        hooks.detectSubvenue(
            "Tutorial on Bayesian inference",
            "International Conference on Machine Learning"
        ),
        null
    );
});

test("explicit contribution labels and venue signals remain subvenues", () => {
    const { hooks } = loadContentHooks();
    assert.equal(hooks.detectSubvenue("Demo: A new system", "ACM SIGCOMM"), "demo");
    assert.equal(hooks.detectSubvenue("A new system", "SIGCOMM Demo Session"), "demo");
    assert.equal(hooks.detectSubvenue("[Poster] - A new system", "ACM SIGCOMM"), "poster");
});

test("metadata identity normalizes title and includes publication year", () => {
    const { hooks } = loadContentHooks();
    assert.equal(
        hooks.metadataIdentity("RouteNet-Erlang: A Graph Neural Network!", 2022),
        "routenet erlang a graph neural network|2022"
    );
    assert.notEqual(
        hooks.metadataCacheKey("RouteNet-Erlang", 2022),
        hooks.metadataCacheKey("RouteNet-Erlang", 2023)
    );
    assert.notEqual(
        hooks.metadataMissKey("dblp", "RouteNet-Erlang", 2022),
        hooks.metadataMissKey("crossref", "RouteNet-Erlang", 2022)
    );
});

test("positive metadata cache is reusable independently of Scholar CID", async () => {
    const { hooks } = loadContentHooks();
    const resolution = {
        type: "conference",
        venue: "IEEE INFOCOM",
        source: "dblp",
        variants: [{ value: "IEEE INFOCOM", origin: "dblp" }]
    };

    assert.equal(await hooks.cacheMetadata("A Paper", 2022, resolution), true);
    const cached = await hooks.getCachedMetadata("A Paper", 2022);
    assert.equal(cached.venue, "IEEE INFOCOM");
    assert.equal(cached.source, "metadata-cache");
    assert.equal(cached.metadataSource, "dblp");
});

test("cache write failures remain non-fatal", async () => {
    const { hooks } = loadContentHooks({
        async set() { throw new Error("QUOTA_BYTES exceeded"); }
    });
    const cached = await hooks.cacheCitation("citation-id", "Paper title", 2026, {
        type: "conference",
        venue: "Example Conference"
    });
    assert.equal(cached, false);
});

test("cache maintenance removes expired and excess entries without touching rankings", async () => {
    const now = Date.now();
    const seed = {
        coreConf: [{ name: "Must remain" }],
        "scholarCite:v12:expired": { resolvedAt: now - 366 * 24 * 60 * 60 * 1000 },
        "scholarCite:v12:malformed": {},
        "scholarMetadataMiss:v14:dblp:expired": { timestamp: now - 8 * 24 * 60 * 60 * 1000 },
        ...Object.fromEntries(
            Array.from({ length: 502 }, (_, index) => [
                `scholarCite:v13-debug:recent-${index}`,
                { resolvedAt: now - index }
            ])
        )
    };
    const memory = createMemoryStorage(seed);
    const { hooks } = loadContentHooks(memory);

    await hooks.maintainLocalCaches();

    assert.equal(memory.data.coreConf.length, 1);
    assert.equal("scholarCite:v12:expired" in memory.data, false);
    assert.equal("scholarCite:v12:malformed" in memory.data, false);
    assert.equal("scholarMetadataMiss:v14:dblp:expired" in memory.data, false);
    assert.equal("scholarCite:v13-debug:recent-501" in memory.data, false);
    assert.equal("scholarCite:v13-debug:recent-0" in memory.data, true);
});

test("only semantic resolver misses are cached for seven days", () => {
    const { hooks } = loadContentHooks();
    assert.equal(hooks.isCacheableResolverMiss("no-high-confidence-candidate"), true);
    assert.equal(hooks.isCacheableResolverMiss("ambiguous-candidates"), true);
    assert.equal(hooks.isCacheableResolverMiss("timeout"), false);
    assert.equal(hooks.isCacheableResolverMiss("HTTP_429"), false);
    assert.equal(hooks.config.metadataMissTtlMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(hooks.config.metadataCacheTtlMs, 365 * 24 * 60 * 60 * 1000);
});

test("negative metadata cache is source-specific", async () => {
    const memory = createMemoryStorage();
    const { hooks } = loadContentHooks(memory);
    const identity = hooks.metadataIdentity("A Paper", 2024);
    const dblpKey = hooks.metadataMissKey("dblp", "A Paper", 2024);
    memory.data[dblpKey] = { identity, timestamp: Date.now() };

    assert.equal(await hooks.hasCachedResolverMiss("dblp", "A Paper", 2024), true);
    assert.equal(await hooks.hasCachedResolverMiss("crossref", "A Paper", 2024), false);
});

test("Scholar Cite is configured as a slow, viewport-gated last fallback", () => {
    const { hooks } = loadContentHooks();
    assert.equal(hooks.config.resolverOrder.join(","), "dblp,crossref");
    assert.equal(hooks.config.citeCachePrefix, "scholarCite:v14:");
    assert.equal(hooks.config.maxCiteLookupsPerPage, 2);
    assert.equal(hooks.config.citeDwellMs, 1500);
    assert.equal(hooks.config.citeDelayMs, 4000);
});

test("positive venue matcher regressions remain covered", () => {
    const { hooks } = loadContentHooks();
    const cases = [
        ["IEEE International Conference on Computer Communications", "INFOCOM", "IEEE INFOCOM 2022-IEEE Conference on Computer Communications"],
        ["Internet Measurement Conference", "IMC", "Internet Measurement Conference"],
        ["International Conference on Trust, Security and Privacy in Computing and Communications", "TrustCom", "International Conference on Trust, Security and Privacy in Computing and Communications (TrustCom)"],
        ["USENIX Security Symposium", "USENIX-Security", "31st USENIX Security Symposium"],
        ["ACM SIGOPS Symposium on Operating Systems Principles", "SOSP", "ACM Symposium on Operating Systems Principles"],
        ["ACM SIGCOMM Conference", "SIGCOMM", "Proceedings of the ACM SIGCOMM 2025 Conference"],
        ["IFIP Conference on Networking", "IFIP Networking", "2026 IFIP Networking Conference (IFIP Networking)"],
        ["IEEE Vehicular Technology Conference", "VTC", "2003 IEEE 58th Vehicular Technology Conference. VTC 2003-Fall"]
    ];

    for (const [name, abbr, venue] of cases) {
        const match = catalogMatch(hooks, name, abbr, venue);
        assert.ok(match, `${abbr} should match ${venue}`);
    }
});

test("adversarial acronym matcher regressions remain rejected", () => {
    const { hooks } = loadContentHooks();
    assert.equal(
        catalogMatch(
            hooks,
            "International Conference on Service Oriented Computing",
            "ICSOC",
            "European Conference on Service-Oriented and Cloud Computing"
        ),
        null
    );
    assert.equal(
        catalogMatch(
            hooks,
            "IEEE International Conference on Cloud Computing",
            "CLOUD",
            "European Conference on Service-Oriented and Cloud Computing"
        ),
        null
    );
    assert.equal(
        catalogMatch(
            hooks,
            "International Conference on Machine Learning",
            "ICML",
            "2024 IEEE International Conference on Machine Learning for Communication and Networking (ICMLCN)"
        ),
        null
    );
    assert.equal(
        catalogMatch(
            hooks,
            "IEEE International Test Conference",
            "ITC",
            "Proc. 16th ITC Specialist Seminar on Performance Evaluation of Wireless and Mobile Systems"
        ),
        null
    );
    assert.equal(
        catalogMatch(
            hooks,
            "Document Analysis Systems",
            "DAS",
            "§ 13. Das Reich unter Kaiser Leopold I."
        ),
        null
    );
});

test("bidirectional token coverage retains equivalent venue identities", () => {
    const { hooks } = loadContentHooks();
    const match = catalogMatch(
        hooks,
        "International Conference on Distributed Systems",
        "",
        "Conference on Distributed Systems"
    );

    assert.ok(match);
    assert.equal(match.matchedBy, "identity-token-match");
    assert.equal(match.tokenStats.catalogCoverage, 1);
    assert.equal(match.tokenStats.venueCoverage, 1);
});

test("genuine acronym-form occurrences retain strong standalone matching", () => {
    const { hooks } = loadContentHooks();
    const cases = [
        ["IEEE International Conference on Computer Communications", "INFOCOM", "Proceedings of IEEE INFOCOM 2025"],
        ["ACM SIGCOMM Conference", "SIGCOMM", "Proceedings of ACM SIGCOMM 2025"],
        ["ACM International Conference on Mobile Systems, Applications, and Services", "MobiSys", "Proceedings of MobiSys 2025"],
        ["International Conference on Trust, Security and Privacy in Computing and Communications", "TrustCom", "Proceedings of TrustCom 2025"],
        ["Network and Distributed System Security Symposium", "NDSS", "Network Security Symposium (NDSS) 2025"],
        ["IEEE International Conference on Cloud Computing", "CLOUD", "Proceedings of IEEE CLOUD 2025"]
    ];

    for (const [name, abbr, venue] of cases) {
        const match = catalogMatch(hooks, name, abbr, venue);
        assert.ok(match, `${abbr} should retain acronym-form matching`);
        assert.match(match.matchedBy, /acronym/);
    }
});

test("truncated organization names cannot create a canonical venue identity", () => {
    const { hooks } = loadContentHooks();
    const ieeeCatalog = [
        hooks.prepareItem({ name: "Proceedings of the IEEE", abbr: "Proc. IEEE", rank: "A" }, "journal", "CCF"),
        hooks.prepareItem({ name: "IEEE Access", abbr: "IEEE Access", rank: "Q1" }, "journal", "SJR"),
        hooks.prepareItem({ name: "IEEE Transactions on Networking", abbr: "TON", rank: "A" }, "journal", "CCF")
    ];
    const acmCatalog = [
        hooks.prepareItem({ name: "Proceedings of the ACM", abbr: "Proc. ACM", rank: "A" }, "journal", "TEST"),
        hooks.prepareItem({ name: "ACM Computing Surveys", abbr: "CSUR", rank: "A" }, "journal", "TEST"),
        hooks.prepareItem({ name: "ACM SIGCOMM Conference", abbr: "SIGCOMM", rank: "A" }, "conference", "TEST")
    ];

    assert.equal(
        hooks.bestCatalogMatch(ieeeCatalog, [{ value: "IEEE …, 2025", origin: "visible" }], "TEST"),
        null
    );
    assert.equal(
        hooks.bestCatalogMatch(acmCatalog, [{ value: "ACM …, 2025", origin: "visible" }], "TEST"),
        null
    );
});

test("IEEE Access does not match Proceedings of the IEEE", () => {
    const { hooks } = loadContentHooks();
    const proceedings = hooks.prepareItem(
        { name: "Proceedings of the IEEE", abbr: "Proc. IEEE", rank: "A" },
        "journal",
        "CCF"
    );

    assert.equal(
        hooks.bestCatalogMatch([proceedings], [{ value: "IEEE Access", origin: "crossref" }], "CCF"),
        null
    );
});

test("the full Proceedings of the IEEE name retains its exact-name match", () => {
    const { hooks } = loadContentHooks();
    const proceedings = hooks.prepareItem(
        { name: "Proceedings of the IEEE", abbr: "Proc. IEEE", rank: "A" },
        "journal",
        "CCF"
    );
    const match = hooks.bestCatalogMatch(
        [proceedings],
        [{ value: "Proceedings of the IEEE", origin: "crossref" }],
        "CCF"
    );

    assert.ok(match);
    assert.equal(match.matchedBy, "exact-name");
    assert.equal(match.item.rank, "A");
});

test("IEEE Access with a truncated visible variant renders SJR only", () => {
    const { hooks } = profileTestEnvironment();
    const rankings = {
        core: [],
        ccfConferences: [],
        ccfJournals: [
            hooks.prepareItem({ name: "Proceedings of the IEEE", abbr: "Proc. IEEE", rank: "A" }, "journal", "CCF")
        ],
        sjr: [
            hooks.prepareItem({ name: "IEEE Access", abbr: "IEEE Access", rank: "Q1" }, "journal", "SJR")
        ]
    };
    const titleElement = new FakeElement(
        "Network digital twin toward networking, telecommunications, and traffic engineering: A survey"
    );

    hooks.renderRanks(titleElement, {
        venue: "IEEE Access",
        type: "journal",
        source: "crossref",
        variants: [
            { value: "IEEE …, 2025", origin: "visible" },
            { value: "IEEE Access", origin: "crossref" }
        ]
    }, titleElement.textContent, rankings);

    assert.deepEqual(
        titleElement.children[0].children.map(child => child.textContent),
        ["[SJR: Q1]"]
    );
});

test("journal and subvenue types do not inherit conference rankings", () => {
    const { hooks } = loadContentHooks();
    const rankings = { core: [], sjr: [], ccfConferences: [], ccfJournals: [] };

    const ccr = hooks.structuredResolution(
        { venue: "SIGCOMM Computer Communication Review", type: "journal" },
        "SIGCOMM Computer Communication Review",
        "A Paper",
        rankings,
        "dblp"
    );
    const routeNetFermi = hooks.structuredResolution(
        { venue: "IEEE/ACM Transactions on Networking", type: "journal" },
        "IEEE/ACM Transactions on Networking",
        "RouteNet-Fermi: Network modeling with graph neural networks",
        rankings,
        "crossref"
    );

    assert.equal(ccr.type, "journal");
    assert.equal(routeNetFermi.type, "journal");
    assert.equal(
        hooks.detectSubvenue("Poster: A MobiSys result", "MobiSys Companion"),
        "companion"
    );
});

test("profile DOM extraction produces the shared paper metadata shape", () => {
    const { hooks } = profileTestEnvironment();
    const { row } = makeProfileRow({
        title: "RouteNet-Erlang: A graph neural network for network performance evaluation",
        authors: "M Ferriol-Galmés, K Rusek, J Suárez-Varela",
        venue: "IEEE INFOCOM 2022 - IEEE Conference on Computer Communications, 2022",
        year: "2022"
    });

    const paper = hooks.extractProfilePaper(row);
    assert.equal(paper.pageType, "profile");
    assert.equal(paper.meta.year, 2022);
    assert.equal(paper.meta.authors.length, 3);
    assert.equal(
        paper.meta.venue,
        "IEEE INFOCOM 2022 - IEEE Conference on Computer Communications"
    );
    assert.equal(paper.badgePlacement, "after-title");
});

test("Scholar citations user URLs are detected as profile pages", () => {
    const { hooks } = loadContentHooks({}, {
        window: {
            location: {
                origin: "https://scholar.google.com",
                pathname: "/citations",
                search: "?user=abc123&hl=en"
            }
        }
    });
    assert.equal(hooks.detectPageType(), "profile");
});

test("cached profile papers reuse the shared matcher without external requests", async () => {
    const { context, hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    let externalRequests = 0;
    context.chrome.runtime.sendMessage = async message => {
        if (message?.action === "resolveMetadata") externalRequests += 1;
        return undefined;
    };

    const cases = [
        {
            title: "RouteNet-Erlang: A graph neural network for network performance evaluation",
            year: 2022,
            resolution: { type: "conference", venue: "INFOCOM", source: "dblp" },
            badges: ["[CORE: A*]", "[CCF: A]"]
        },
        {
            title: "RouteNet-Fermi: Network modeling with graph neural networks",
            year: 2023,
            resolution: { type: "journal", venue: "IEEE/ACM Transactions on Networking", source: "crossref" },
            badges: ["[CCF: A]", "[SJR: Q1]"]
        },
        {
            title: "The Google File System",
            year: 2003,
            resolution: { type: "conference", venue: "ACM Symposium on Operating Systems Principles", source: "dblp" },
            badges: ["[CORE: A*]", "[CCF: A]"]
        },
        {
            title: "A special-purpose peer-to-peer file sharing system for mobile ad hoc networks",
            year: 2003,
            resolution: {
                type: "conference",
                venue: "2003 IEEE 58th Vehicular Technology Conference. VTC 2003-Fall",
                source: "crossref"
            },
            badges: ["[CORE: B]"]
        }
    ];

    for (const item of cases) {
        await hooks.cacheMetadata(item.title, item.year, item.resolution);
        const { cell, row } = makeProfileRow({ title: item.title, year: item.year });
        await hooks.processPublication(row, rankings, "profile");
        assert.deepEqual(badgeTexts(cell), item.badges, item.title);
    }

    assert.equal(externalRequests, 0);
    assert.equal(hooks.debugStats.citeRequests, 0);
    assert.equal(hooks.debugStats.profileCiteRequests, 0);
    assert.equal(hooks.debugStats.metadataCacheHits, 4);
});

test("uncached profile rows outside the viewport produce no external requests", async () => {
    const { context, hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    let externalRequests = 0;
    context.chrome.runtime.sendMessage = async message => {
        if (message?.action === "resolveMetadata") externalRequests += 1;
        return undefined;
    };
    const { row } = makeProfileRow({ title: "Uncached Paper", year: 2024 });

    await hooks.processPublication(row, rankings, "profile");

    assert.equal(row.dataset.svrState, "waiting-for-profile-viewport");
    assert.equal(externalRequests, 0);
    assert.equal(hooks.debugStats.profileRowsObserved, 1);
    assert.equal(hooks.debugStats.citeRequests, 0);
});

test("scrolling a profile paper into view starts DBLP but not Crossref after success", async () => {
    const { context, hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    const resolvers = [];
    context.chrome.runtime.sendMessage = async message => {
        if (message?.action !== "resolveMetadata") return undefined;
        resolvers.push(message.resolver);
        return {
            resolved: true,
            requestId: "dblp-profile-1",
            venue: "INFOCOM",
            publicationType: "conference",
            confidence: "exact-title-year",
            source: "dblp"
        };
    };
    const { cell, row } = makeProfileRow({
        title: "RouteNet-Erlang: A graph neural network for network performance evaluation",
        year: 2022
    });
    await hooks.processPublication(row, rankings, "profile");

    MockIntersectionObserver.instances[0].trigger(row, true);
    await flushAsyncWork();

    assert.deepEqual(resolvers, ["dblp"]);
    assert.deepEqual(badgeTexts(cell), ["[CORE: A*]", "[CCF: A]"]);
    assert.equal(hooks.debugStats.profileExternalResolutions, 1);
    assert.equal(hooks.debugStats.citeRequests, 0);
});

test("profile resolution falls through DBLP to Crossref without Scholar Cite", async () => {
    const { context, hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    const resolvers = [];
    context.chrome.runtime.sendMessage = async message => {
        if (message?.action !== "resolveMetadata") return undefined;
        resolvers.push(message.resolver);
        if (message.resolver === "dblp") {
            return {
                resolved: false,
                requestId: "dblp-profile-miss",
                reason: "no-high-confidence-candidate",
                source: "dblp"
            };
        }
        return {
            resolved: true,
            requestId: "crossref-profile-hit",
            venue: "IEEE/ACM Transactions on Networking",
            publicationType: "journal",
            confidence: "exact-title-year",
            source: "crossref"
        };
    };
    const { cell, row } = makeProfileRow({
        title: "RouteNet-Fermi: Network modeling with graph neural networks",
        year: 2023
    });
    await hooks.processPublication(row, rankings, "profile");

    MockIntersectionObserver.instances[0].trigger(row, true);
    await flushAsyncWork();

    assert.deepEqual(resolvers, ["dblp", "crossref"]);
    assert.deepEqual(badgeTexts(cell), ["[CCF: A]", "[SJR: Q1]"]);
    assert.equal(hooks.debugStats.citeRequests, 0);
});

test("unresolved profile papers stop after Crossref", async () => {
    const { context, hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    const resolvers = [];
    context.chrome.runtime.sendMessage = async message => {
        if (message?.action !== "resolveMetadata") return undefined;
        resolvers.push(message.resolver);
        return {
            resolved: false,
            requestId: `${message.resolver}-unresolved`,
            reason: "no-high-confidence-candidate",
            source: message.resolver
        };
    };
    const { cell, row } = makeProfileRow({ title: "Unknown Publication", year: 2024 });
    await hooks.processPublication(row, rankings, "profile");

    MockIntersectionObserver.instances[0].trigger(row, true);
    await flushAsyncWork();

    assert.deepEqual(resolvers, ["dblp", "crossref"]);
    assert.deepEqual(badgeTexts(cell), []);
    assert.equal(row.dataset.svrState, "done");
    assert.equal(hooks.debugStats.citeRequests, 0);
});

test("profile rows are processed once and newly loaded rows are registered separately", async () => {
    const { hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    const first = makeProfileRow({ title: "First Paper", year: 2023 }).row;
    const second = makeProfileRow({ title: "Second Paper", year: 2024 }).row;

    hooks.observeDynamicResults(rankings, "profile");
    const mutationObserver = MockMutationObserver.instances[0];
    mutationObserver.trigger([first]);
    await flushAsyncWork();
    mutationObserver.trigger([first, second]);
    await flushAsyncWork();

    assert.equal(hooks.debugStats.profileRowsDetected, 2);
    assert.equal(hooks.debugStats.profileRowsObserved, 2);
    assert.equal(MockIntersectionObserver.instances[0].targets.size, 2);
});

test("profile rendering never invents a rank absent from the loaded catalog", async () => {
    const { hooks } = profileTestEnvironment();
    const rankings = preparedRankings(hooks);
    const title = "A Paper at the International Conference on Network of the Future";
    await hooks.cacheMetadata(title, 2024, {
        type: "conference",
        venue: "International Conference on Network of the Future",
        source: "dblp"
    });
    const { cell, row } = makeProfileRow({ title, year: 2024 });

    await hooks.processPublication(row, rankings, "profile");

    assert.deepEqual(badgeTexts(cell), []);
    assert.equal(hooks.debugStats.citeRequests, 0);
});

test("profile pages preserve ICMLCN, ITC, and SIGCOMM CCR false-positive guards", async () => {
    const { hooks } = profileTestEnvironment();
    const rankings = {
        core: [
            hooks.prepareItem({ name: "International Conference on Machine Learning", abbr: "ICML", rank: "A*" }, "conference", "CORE"),
            hooks.prepareItem({ name: "IEEE International Test Conference", abbr: "ITC", rank: "A" }, "conference", "CORE"),
            hooks.prepareItem({ name: "ACM SIGCOMM Conference", abbr: "SIGCOMM", rank: "A*" }, "conference", "CORE")
        ],
        ccfConferences: [],
        sjr: [],
        ccfJournals: []
    };
    const cases = [
        {
            title: "7D: Demonstrating Drill-Down DDoS Destination Detection",
            year: 2024,
            resolution: {
                type: "conference",
                venue: "2024 IEEE International Conference on Machine Learning for Communication and Networking (ICMLCN)",
                source: "dblp"
            }
        },
        {
            title: "Optimizing IEEE 802.11 performance",
            year: 2005,
            resolution: {
                type: "conference",
                venue: "Proc. 16th ITC Specialist Seminar on Performance Evaluation of Wireless and Mobile Systems",
                source: "crossref"
            }
        },
        {
            title: "A SIGCOMM CCR article",
            year: 2024,
            resolution: {
                type: "journal",
                venue: "SIGCOMM Computer Communication Review",
                source: "dblp"
            }
        }
    ];

    for (const item of cases) {
        await hooks.cacheMetadata(item.title, item.year, item.resolution);
        const { cell, row } = makeProfileRow({ title: item.title, year: item.year });
        await hooks.processPublication(row, rankings, "profile");
        assert.deepEqual(badgeTexts(cell), [], item.title);
    }

    assert.equal(hooks.debugStats.citeRequests, 0);
});
