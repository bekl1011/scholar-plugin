const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundScript = fs.readFileSync(
    path.join(__dirname, "..", "background.js"),
    "utf8"
);

async function runBackground(existingAlarm, overrides = {}) {
    const created = [];
    let messageListener = null;
    const context = {
        AbortController,
        URL,
        chrome: {
            alarms: {
                async create(name, options) { created.push({ name, options }); },
                async get() { return existingAlarm; },
                onAlarm: { addListener() {} }
            },
            runtime: {
                onInstalled: { addListener() {} },
                onMessage: { addListener(listener) { messageListener = listener; } }
            },
            storage: { local: { async set() {} } }
        },
        clearTimeout,
        console: { error() {}, log() {} },
        fetch,
        setTimeout,
        __SVR_ENABLE_TEST_HOOKS__: true,
        ...overrides
    };

    vm.runInNewContext(backgroundScript, context, { filename: "background.js" });
    await new Promise(resolve => setImmediate(resolve));
    return {
        created,
        hooks: context.__SVR_BACKGROUND_TEST_HOOKS__,
        messageListener
    };
}

test("service-worker startup recreates a missing ranking alarm", async () => {
    const { created } = await runBackground(undefined);
    assert.equal(created.length, 1);
    assert.equal(created[0].name, "updateRankings");
    assert.equal(created[0].options.periodInMinutes, 10080);
});

test("service-worker startup keeps an existing ranking alarm", async () => {
    const { created } = await runBackground({ name: "updateRankings" });
    assert.deepEqual(created, []);
});

test("DBLP response parsing extracts venue, year, authors, and type", async () => {
    const { hooks } = await runBackground({ name: "updateRankings" });
    const candidates = hooks.parseDblpCandidates({
        result: {
            hits: {
                hit: [{
                    info: {
                        title: "RouteNet-Erlang: A Graph Neural Network",
                        year: "2022",
                        venue: "INFOCOM",
                        type: "Conference and Workshop Papers",
                        authors: { author: [{ text: "Paul Almasan" }, { text: "Jordi Suárez-Varela" }] }
                    }
                }]
            }
        }
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].venue, "INFOCOM");
    assert.equal(candidates[0].year, 2022);
    assert.equal(candidates[0].publicationType, "conference");
    assert.equal(candidates[0].authors[0], "Paul Almasan");
});

test("Crossref response parsing uses container-title and proceedings type", async () => {
    const { hooks } = await runBackground({ name: "updateRankings" });
    const candidates = hooks.parseCrossrefCandidates({
        message: {
            items: [{
                title: ["A Paper"],
                "container-title": ["IEEE INFOCOM 2022"],
                type: "proceedings-article",
                published: { "date-parts": [[2022, 5, 1]] },
                author: [{ given: "Ada", family: "Lovelace" }]
            }]
        }
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].venue, "IEEE INFOCOM 2022");
    assert.equal(candidates[0].year, 2022);
    assert.equal(candidates[0].publicationType, "conference");
});

test("candidate selection requires an exact normalized title", async () => {
    const { hooks } = await runBackground({ name: "updateRankings" });
    const paper = { title: "Exact Paper Title", year: 2024, authors: ["Ada Lovelace"] };

    const accepted = hooks.selectHighConfidenceCandidate(paper, [{
        title: "Exact paper title.",
        year: 2024,
        authors: ["Ada Lovelace"],
        venue: "Example Conference",
        publicationType: "conference"
    }], "dblp");
    const rejected = hooks.selectHighConfidenceCandidate(paper, [{
        title: "A similar but different paper title",
        year: 2024,
        authors: ["Ada Lovelace"],
        venue: "Example Conference",
        publicationType: "conference"
    }], "dblp");

    assert.equal(accepted.resolved, true);
    assert.equal(accepted.confidence, "exact-title-year");
    assert.equal(rejected.resolved, false);
    assert.equal(rejected.reason, "no-high-confidence-candidate");
});

test("near-year candidates are accepted only when unique", async () => {
    const { hooks } = await runBackground({ name: "updateRankings" });
    const paper = { title: "Exact Paper", year: 2024, authors: [] };
    const base = {
        title: "Exact Paper",
        year: 2023,
        authors: [],
        publicationType: "conference"
    };

    const unique = hooks.selectHighConfidenceCandidate(paper, [
        { ...base, venue: "Venue A" }
    ], "dblp");
    const ambiguous = hooks.selectHighConfidenceCandidate(paper, [
        { ...base, venue: "Venue A" },
        { ...base, venue: "Venue B" }
    ], "dblp");

    assert.equal(unique.resolved, true);
    assert.equal(unique.confidence, "exact-title-near-year");
    assert.equal(ambiguous.resolved, false);
});

test("author overlap can disambiguate exact-title candidates", async () => {
    const { hooks } = await runBackground({ name: "updateRankings" });
    const result = hooks.selectHighConfidenceCandidate({
        title: "Shared Title",
        year: 2024,
        authors: ["Ada Lovelace"]
    }, [
        {
            title: "Shared Title", year: 2024, authors: ["Ada Lovelace"],
            venue: "Venue A", publicationType: "conference"
        },
        {
            title: "Shared Title", year: 2024, authors: ["Grace Hopper"],
            venue: "Venue B", publicationType: "conference"
        }
    ], "crossref");

    assert.equal(result.resolved, true);
    assert.equal(result.venue, "Venue A");
});

test("resolver queue deduplicates simultaneous identical lookups", async () => {
    const { hooks } = await runBackground({ name: "updateRankings" });
    const enqueue = hooks.createResolverQueue(0);
    let calls = 0;
    const task = async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return "result";
    };

    const [first, second] = await Promise.all([
        enqueue("same-paper", task),
        enqueue("same-paper", task)
    ]);

    assert.equal(first, "result");
    assert.equal(second, "result");
    assert.equal(calls, 1);
});
