const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundScript = fs.readFileSync(
    path.join(__dirname, "..", "background.js"),
    "utf8"
);

async function runBackground(existingAlarm) {
    const created = [];
    const context = {
        chrome: {
            alarms: {
                async create(name, options) { created.push({ name, options }); },
                async get() { return existingAlarm; },
                onAlarm: { addListener() {} }
            },
            runtime: {
                onInstalled: { addListener() {} },
                onMessage: { addListener() {} }
            },
            storage: { local: { async set() {} } }
        },
        console: { error() {}, log() {} },
        fetch
    };

    vm.runInNewContext(backgroundScript, context, { filename: "background.js" });
    await new Promise(resolve => setImmediate(resolve));
    return created;
}

test("service-worker startup recreates a missing ranking alarm", async () => {
    const created = await runBackground(undefined);

    assert.equal(created.length, 1);
    assert.equal(created[0].name, "updateRankings");
    assert.equal(created[0].options.periodInMinutes, 10080);
});

test("service-worker startup keeps an existing ranking alarm", async () => {
    const created = await runBackground({ name: "updateRankings" });
    assert.deepEqual(created, []);
});
