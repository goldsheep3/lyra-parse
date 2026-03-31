// Incremental JSON import with normalization

function importJson(data) {
    for (const item of data) {
        // Normalize achievementRate to achievement
        item.achievement = item.achievementRate;
        delete item.achievementRate;

        // Handle missing titles/types/difficulty
        if (!item.title || !item.type || !item.diff) {
            item.title = item.sheetId ? fetchTitle(item.sheetId) : 'Unknown Title';
            item.type = item.type || 'Unknown Type';
            item.diff = item.diff || 'Unknown Difficulty';
        }

        // Merging combo/sync by rank weight only if better
        if (shouldMerge(item)) {
            mergeItem(item);
        }
    }
}

function fetchTitle(sheetId) {
    // Logic to fetch the title based on sheetId
}

function shouldMerge(item) {
    // Logic to determine if the current item should merge based on rank weight
}

function mergeItem(item) {
    // Logic to merge items
}
