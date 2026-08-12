const DATA_SOURCES = {
    coreConf: "https://raw.githubusercontent.com/bekl1011/rankings/main/core_conferences.json",
    ccfConf: "https://raw.githubusercontent.com/bekl1011/rankings/main/ccf_conferences.json",
    journals: "https://raw.githubusercontent.com/bekl1011/rankings/main/scimago_journals.json"
};

const UPDATE_INTERVAL_MINUTES = 10080; // 7 Tage

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
    chrome.alarms.create("updateRankings", { periodInMinutes: UPDATE_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "updateRankings") fetchAndCacheRankings();
});

// content.js fragt dies ab, falls der Storage beim Laden noch leer ist.
// In älteren Versionen gab es dafür keinen Listener; v12 macht diesen
// Fallback explizit funktionsfähig.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "ensureRankings") return false;

    fetchAndCacheRankings().then(sendResponse);
    return true; // asynchrone sendResponse-Antwort offen halten
});
