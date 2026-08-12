const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
    path.join(__dirname, "..", "content.js"),
    "utf8"
);

function loadContentHooks(storageOverrides = {}) {
    const storage = {
        async get() { return {}; },
        async set() {},
        async remove() {},
        ...storageOverrides
    };

    const context = {
        AbortController,
        URL,
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
            documentElement: { lang: "en" },
            querySelectorAll() { return []; }
        },
        setTimeout,
        clearTimeout,
        window: { location: { origin: "https://scholar.google.com" } },
        __SVR_ENABLE_TEST_HOOKS__: true
    };

    vm.runInNewContext(contentScript, context, { filename: "content.js" });
    return { hooks: context.__SVR_TEST_HOOKS__, storage };
}

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

test("cache maintenance removes expired, malformed, and excess cite entries", async () => {
    const now = Date.now();
    const stored = {
        coreConf: [{ name: "Must remain" }],
        "scholarCite:v12:expired": { resolvedAt: now - 366 * 24 * 60 * 60 * 1000 },
        "scholarCite:v12:malformed": {},
        ...Object.fromEntries(
            Array.from({ length: 502 }, (_, index) => [
                `scholarCite:v13-debug:recent-${index}`,
                { resolvedAt: now - index }
            ])
        )
    };
    let removed = [];
    const { hooks } = loadContentHooks({
        async get() { return stored; },
        async remove(keys) { removed = keys; }
    });

    await hooks.maintainCitationCache();

    assert.equal(removed.includes("coreConf"), false);
    assert.equal(removed.includes("scholarCite:v12:expired"), true);
    assert.equal(removed.includes("scholarCite:v12:malformed"), true);
    assert.equal(removed.includes("scholarCite:v13-debug:recent-501"), true);
    assert.equal(removed.includes("scholarCite:v13-debug:recent-0"), false);
});
