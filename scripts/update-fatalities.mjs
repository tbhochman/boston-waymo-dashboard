#!/usr/bin/env node

/**
 * Fetches Boston traffic fatality data from the Analyze Boston (data.boston.gov) CKAN API
 * and updates src/data/fatalities.json with current numbers.
 *
 * The script:
 * - Queries the Vision Zero Fatality Records dataset
 * - Counts fatalities by year
 * - For completed years, keeps the existing manually-vetted values
 *   (the BPD-only API undercounts vs the broader all-roads figures we use)
 * - For the current year, uses API YTD count and projects a full-year estimate
 * - Updates the permit timeline months-waiting count
 * - Updates the last timeline entry's cumulative death count and date
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, "..", "src", "data", "fatalities.json");

// Boston Vision Zero Fatality Records on data.boston.gov (CKAN API)
const API_URL =
  "https://data.boston.gov/api/3/action/datastore_search?resource_id=92f18923-d4ec-4c17-9405-4e0da63e1d6c&limit=1000";

function countByYear(records) {
  const yearly = {};
  for (const record of records) {
    // The dataset has a "Date" or "date" field
    const dateStr = record.Date || record.date || record.DATE;
    if (!dateStr) continue;
    const year = new Date(dateStr).getFullYear();
    if (isNaN(year)) continue;
    yearly[year] = (yearly[year] || 0) + 1;
  }
  return yearly;
}

function monthsSince(dateStr) {
  const start = new Date(dateStr + "-01");
  const now = new Date();
  return (
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth())
  );
}

function currentMonthLabel() {
  const now = new Date();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

async function fetchAllRecords() {
  const records = [];
  let offset = 0;

  while (true) {
    const url = `${API_URL}&offset=${offset}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.success) {
      console.error("API error:", data.error);
      break;
    }

    const results = data.result?.records || [];
    if (results.length === 0) break;

    records.push(...results);
    offset += results.length;

    // If we got fewer than the limit, we're done
    if (results.length < 1000) break;
  }

  return records;
}

async function main() {
  console.log("Fetching fatality data from Boston Vision Zero API...");

  const records = await fetchAllRecords();
  console.log(`Total records fetched: ${records.length}`);

  const apiCounts = countByYear(records);
  console.log("API fatality counts by year:", apiCounts);

  // Read existing data
  const data = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth(); // 0-indexed
  let changed = false;

  // Update byYear entries — only update the current year's projection
  // We keep manually-vetted values for completed years because the BPD-only
  // API undercounts (it excludes state police jurisdiction roads)
  for (const entry of data.bostonFatalities.byYear) {
    const apiCount = apiCounts[entry.year];
    if (apiCount == null) continue;

    if (entry.year === currentYear) {
      // For current year: use API count for YTD, project full year
      // Note: API only covers BPD roads, so we use it as a lower bound
      const monthFraction = (currentMonth + 1) / 12;
      const projected = Math.round(apiCount / monthFraction);
      if (projected !== entry.deaths) {
        console.log(
          `Updating ${entry.year}: ${entry.deaths} -> ${projected} (projected from ${apiCount} YTD through month ${currentMonth + 1})`
        );
        entry.deaths = projected;
        entry.note = `Projected from ${apiCount} YTD`;
        changed = true;
      }
    }
  }

  // Check if we need to add a new year entry
  if (!data.bostonFatalities.byYear.find((e) => e.year === currentYear)) {
    const apiCount = apiCounts[currentYear] || 0;
    const monthFraction = (currentMonth + 1) / 12;
    const projected = Math.round(apiCount / monthFraction);
    data.bostonFatalities.byYear.push({
      year: currentYear,
      deaths: projected,
      note: `Projected from ${apiCount} YTD`,
    });
    changed = true;
    console.log(`Added ${currentYear}: ${projected} (projected from ${apiCount} YTD)`);
  }

  // Update permit timeline months for Boston
  const bostonPermit = data.permitTimeline.find(
    (p) => p.city === "Boston, MA"
  );
  if (bostonPermit && bostonPermit.testStart) {
    const newMonths = monthsSince(bostonPermit.testStart);
    if (newMonths !== bostonPermit.months) {
      console.log(
        `Updating Boston permit months: ${bostonPermit.months} -> ${newMonths}`
      );
      bostonPermit.months = newMonths;
      changed = true;
    }
  }

  // Update the last timeline entry with current date and cumulative deaths
  const lastEvent = data.timeline[data.timeline.length - 1];
  // Parse delay start year directly to avoid timezone issues
  const delayStartYear = parseInt(data.bostonFatalities.delayStart.split("-")[0], 10);

  // Calculate cumulative deaths since delay start
  let cumulative = 0;
  for (const entry of data.bostonFatalities.byYear) {
    if (entry.year < delayStartYear) continue;
    if (entry.year < currentYear) {
      cumulative += entry.deaths;
    } else if (entry.year === currentYear) {
      // Partial year: interpolate based on current month
      cumulative += Math.round(entry.deaths * ((currentMonth + 1) / 12));
    }
  }

  const newDateLabel = currentMonthLabel();
  if (
    lastEvent.date !== newDateLabel ||
    lastEvent.cumulativeDeaths !== cumulative
  ) {
    console.log(
      `Updating last timeline entry: "${lastEvent.date}" (${lastEvent.cumulativeDeaths}) -> "${newDateLabel}" (${cumulative})`
    );
    lastEvent.date = newDateLabel;
    lastEvent.cumulativeDeaths = cumulative;
    changed = true;
  }

  if (changed) {
    writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
    console.log("fatalities.json updated.");
  } else {
    console.log("No changes needed.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
