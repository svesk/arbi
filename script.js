// --- CONSTANTS ---
let currentSaturationSegments = [];
const DROP_CHANCE = 0.15;
const RETRIEVER_CHANCE = 0.18;
// --- MIRROR DEFENSE MAPS (Saturation Under Maintenance) - REMOVABLE FLAG ---
const MIRROR_DEFENSE_MAPS = ['Munio', 'Tyana'];
const DISABLE_SATURATION_FOR_MIRROR_DEFENSE = false; // mirror defense saturation enabled for maps listed below
// --- END REMOVABLE SECTION ---
const SCENARIOS = [
    { z: -2.326, prob: "99%", desc: "Worst Case" },
    { z: -1.282, prob: "90%", desc: "Unlucky" },
    { z: -0.674, prob: "75%", desc: "Below Avg" },
    { z: 0.000, prob: "50%", desc: "Average" },
    { z: 0.674, prob: "25%", desc: "Above Avg" },
    { z: 1.282, prob: "10%", desc: "High Roll" },
    { z: 2.326, prob: " 1%", desc: "God Roll" }
];

// --- UI ELEMENTS ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const statusDiv = document.getElementById('status');
const spinner = document.getElementById('loadingSpinner');
const dashboard = document.getElementById('dashboard');
const uploadSection = document.getElementById('uploadSection');
const downloadBtn = document.getElementById('downloadBtn');
const sectionWaveMap = document.getElementById('sectionWaveMap');
const waveMapPanel = document.getElementById('waveMapPanel');
const missionBadge = document.getElementById('missionBadge');

let inputFileName = "EE.log";
let currentStats = null;

// --- EVENTS ---
dropZone.onclick = () => fileInput.click();
dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
dropZone.ondragleave = () => dropZone.classList.remove('dragover');
dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
};
fileInput.onchange = (e) => { if (e.target.files.length) processFile(e.target.files[0]); };

// --- MAIN ---
async function processFile(file) {
    inputFileName = file.name.replace(/\.[^/.]+$/, "");
    spinner.style.display = 'block';
    dropZone.style.display = 'none';

    try {
        // Stream Process: Reads and analyzes simultaneously to save RAM
        const stats = await parseFileStream(file); 
        currentStats = stats;
        renderDashboard(stats);

        dashboard.classList.remove('hidden');
        spinner.style.display = 'none';
        statusDiv.textContent = "";
        uploadSection.style.marginBottom = "0px";
        document.querySelector('.subtitle').style.display = 'none';

    } catch (error) {
        console.error(error);
        spinner.style.display = 'none';
        dropZone.style.display = 'block';
        
        // Specific help for permission/read errors
        if (error.name === "NotReadableError") {
            statusDiv.innerHTML = "<b>Error:</b> File is locked!<br>The game is currently writing to this file.<br>Please <b>copy</b> the EE.log to your Desktop and upload the copy.";
            statusDiv.style.color = "#ff5252";
        } else if (error.message.includes("Memory")) {
             statusDiv.textContent = "Error: Out of Memory. (This update should fix this, try reloading)";
             statusDiv.style.color = "red";
        } else {
            statusDiv.textContent = "Error: " + error.message;
            statusDiv.style.color = "red";
        }
    }
}

// --- STREAMING ANALYZER (Replaces Cleaner & Analyzer) ---
async function parseFileStream(file) {
    const CHUNK_SIZE = 1024 * 1024 * 10; // Read in 10MB chunks
    let offset = 0;
    let leftover = "";
    
    // --- STATE MANAGEMENT ---
    let sessions = [];
    
    const createStats = () => ({
        droneKills: 0,
        enemySpawns: 0,
        rounds: 0,
        isDefense: false,
        isInterception: false,
        droneTimestamps: [],
        rewardTimestamps: [],
        waveStarts: {},
        liveCounts: [],
        pauseIntervals: [],
        lastRewardTime: 0,
        missionName: "Unknown Node",
        hasData: false,
        lastActivityTime: 0,
        currentPauseStart: null,
        currentSimCap: 32,
        preciseStartTime: null,
        // collected raw spawn records for strict non-ticking analysis (ported from exc/spawns.py)
        allSpawns: [] // { name: string, tick: number | null }
    });
    
    let current = createStats();

    // Agents to force-count even if analysis suggests they don't tick
    const FORCED_VALID_AGENTS = new Set([
        "CorpusEliteShieldDroneAgent"
    ]);

    // --- REGEX PATTERNS (Compiled once for speed) ---
    const p_overlay = /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name: (.*)/;
    const p_agent = /OnAgentCreated/;
    // Attempt to capture agent name and MonitoredTicking when present
    const p_agent_full = /OnAgentCreated.*?\/Npc\/(.+?)(\d+)\s+.*?MonitoredTicking\s+(\d+)/;
    const p_drone = /OnAgentCreated.*?CorpusEliteShieldDroneAgent/;
    const p_excludedAgents = /(Replicant|RJCrew|petavatar|VoidClone|Turret|Dropship|CatbrowPetAgent|AllyAgent)/i;
    const p_reward_def = /Sys \[Info\]: Created \/Lotus\/Interface\/DefenseReward\.swf/;
    const p_sleep = /WaveDefend\.lua: _SleepBetweenWaves/;
    const p_waveStart = /WaveDefend\.lua: Starting wave (\d+)/;
    const p_interception_start = /Script \[Info\]: TerritoryMission\.lua/;
    const p_waveCap = /WaveDefend\.lua: Starting wave \d+.*?\((\d+) simultaneous/;
    const p_monitored = /AI \[Info\]: .*?MonitoredTicking (\d+)/;
    const p_defWave = /WaveDefend\.lua: Defense wave: 1/;
    const p_waveDef = /^(\d+\.\d+).*WaveDefend\.lua: Defense wave: (\d+)/;
    const p_timestamp = /^(\d+\.\d+)/;

    // --- READ LOOP ---
    while (offset < file.size) {
        // 1. Read a chunk
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const text = await slice.text();
        
        // 2. Handle line breaks across chunks
        const currentData = leftover + text;
        let lastIdx = currentData.lastIndexOf('\n');
        
        // If EOF, force process everything
        if (offset + CHUNK_SIZE >= file.size && lastIdx === -1) {
             lastIdx = currentData.length; 
        }

        const chunk = lastIdx !== -1 ? currentData.substring(0, lastIdx) : "";
        leftover = lastIdx !== -1 ? currentData.substring(lastIdx + 1) : currentData;

        // 3. Process Lines Immediately (No giant string storage)
        const lines = chunk.split(/\r?\n/);
        for (let line of lines) {
            if (!line) continue;
            
            // Optimization: Skip spam lines early
            let isSpam = false;
            if (line.includes("Game [Warning]:") || line.includes("DamagePct")) isSpam = true;
            if (isSpam) continue;

            // --- ANALYSIS LOGIC ---
            let timestamp = 0;
            const tsMatch = line.match(p_timestamp);
            if (tsMatch) timestamp = parseFloat(tsMatch[1]);

            // Mission Start
            const mMission = line.match(p_overlay);
            if (mMission) {
                let name = mMission[1].trim();
                if (name.includes("Arbitration")) {
                    // Check if previous session was stale/invalid or just starting
                    if (timestamp > 0 && current.lastActivityTime > 0 && timestamp < current.lastActivityTime) {
                        continue;
                    }
                    if (current.hasData || current.missionName !== "Unknown Node") sessions.push(current);
                    current = createStats();
                    current.missionName = name.replace("Arbitration:", "").trim();

                    // --- EARLY MISSION-TYPE DETECTION ---
                    // If mission name contains 'Defense' or 'Interception' mark the
                    // session accordingly *immediately* so MonitoredTicking lines
                    // (which can appear before 'Defense wave: 1') are treated
                    // using the strict defense/interception logic (no live-fallback).
                    const mNameLower = current.missionName.toLowerCase();
                    if (mNameLower.includes('defense')) {
                        current.isDefense = true;
                    } else if (mNameLower.includes('interception')) {
                        current.isInterception = true;
                    }

                    // ALSO: Mirror Defense nodes are sometimes identified only by
                    // the node name (e.g. 'Munio', 'Alator', 'Tyana'). Ensure these
                    // are treated as Defense so MonitoredTicking is applied.
                    if (!current.isDefense && Array.isArray(MIRROR_DEFENSE_MAPS)) {
                        const nodeMatch = MIRROR_DEFENSE_MAPS.some(m => current.missionName.toLowerCase().includes(m.toLowerCase()));
                        if (nodeMatch) current.isDefense = true;
                    }

                    if (timestamp) current.lastActivityTime = timestamp;
                }
                continue;
            }

            // Pause Logic
            if (p_sleep.test(line) || p_reward_def.test(line)) {
                if (current.currentPauseStart === null && timestamp > 0) current.currentPauseStart = timestamp;
            }
            let isUnpause = false;
            if (current.isDefense && p_waveStart.test(line)) isUnpause = true;
            if (p_interception_start.test(line)) { current.isInterception = true; isUnpause = true; }

            if (isUnpause && current.currentPauseStart !== null && timestamp > 0) {
                current.pauseIntervals.push({ start: current.currentPauseStart, end: timestamp });
                current.currentPauseStart = null;
            }

            const p_defStart1 = /WaveDefend\.lua: Defense wave: 1/;
            const p_intStartInit = /Script \[Info\]: TerritoryMission\.lua: .*?(?:control|captured|Control|Captured)/;

            if (current.preciseStartTime === null) {
                if (p_defStart1.test(line)) {
                    current.preciseStartTime = timestamp;
                }
                else if (p_intStartInit.test(line)) {
                    current.preciseStartTime = timestamp;
                    current.isInterception = true;
                }
            }

            // Round Counting (Defense / Interception only)
            let isRoundEvent = false;
            if (p_reward_def.test(line)) isRoundEvent = true;
            if (isRoundEvent) {
                if (timestamp - current.lastRewardTime > 30) {
                    current.rounds++;
                    current.hasData = true;
                    current.lastRewardTime = timestamp;
                    current.rewardTimestamps.push(timestamp);
                    current.lastActivityTime = Math.max(current.lastActivityTime, timestamp);
                    if (current.currentPauseStart === null) current.currentPauseStart = timestamp;
                }
            }

            const mCap = line.match(p_waveCap);
            if (mCap) current.currentSimCap = parseInt(mCap[1]);

            let dataPoint = null;
            const mMonitored = line.match(p_monitored);

            // Only use MonitoredTicking for Defense / Interception (Mirror Defense marked as Defense)
            if ((current.isDefense || current.isInterception) && mMonitored) {
                dataPoint = { t: timestamp, val: parseInt(mMonitored[1]), cap: current.currentSimCap };
            }
            if (dataPoint && timestamp) current.liveCounts.push(dataPoint);

            // Gameplay Data
            if (p_drone.test(line)) {
                current.droneKills++;
                current.hasData = true;
                if (timestamp) {
                    current.droneTimestamps.push(timestamp);
                    current.lastActivityTime = Math.max(current.lastActivityTime, timestamp);
                }
            } else if (p_agent.test(line)) {
                // Exclude certain agents from strict spawn counts but keep line for saturation
                const isExcludedAgent = p_excludedAgents.test(line);
                if (isExcludedAgent) continue;

                // Basic increment for compatibility
                current.enemySpawns++;

                // Attempt to capture detailed spawn info (name + MonitoredTicking) similar to exc/spawns.py
                const mAgentFull = line.match(p_agent_full);
                if (mAgentFull) {
                    const agentName = mAgentFull[1];
                    const tick = parseInt(mAgentFull[3]);
                    current.allSpawns.push({ name: agentName, tick: isNaN(tick) ? null : tick });
                } else {
                    // Fallback: try to extract name only
                    const mNpc = line.match(/\/Npc\/([A-Za-z0-9_]+)/);
                    if (mNpc) {
                        current.allSpawns.push({ name: mNpc[1], tick: null });
                    } else {
                        current.allSpawns.push({ name: null, tick: null });
                    }
                }
            }

            if (p_defWave.test(line)) current.isDefense = true;
            let mWave = line.match(p_waveDef);
            if (mWave && timestamp) {
                current.waveStarts[parseInt(mWave[2])] = timestamp;
                current.lastActivityTime = Math.max(current.lastActivityTime, timestamp);
            }
        }

        offset += CHUNK_SIZE;
        
        // Update UI Progress
        let pct = Math.min(100, (offset / file.size) * 100).toFixed(0);
        statusDiv.textContent = `Analyzing... ${pct}%`;
        
        // Critical: Yield to UI thread to prevent browser freeze
        await new Promise(r => setTimeout(r, 0));
    }

    // --- FINALIZE ---
    if (current.hasData || current.missionName !== "Unknown Node") sessions.push(current);

    // Pick best session
    let bestSession = null;
    for (let i = sessions.length - 1; i >= 0; i--) {
        const s = sessions[i];
        if (s.rounds > 0 && s.droneKills > 20) { bestSession = s; break; }
    }

    const chosen = bestSession || sessions[sessions.length - 1] || createStats();

    // --- STRICT Non-Ticking Agent Analysis (ported from exc/spawns.py) ---
    // NOTE: This block performs a strict *counting* filter for enemySpawns only.
    // It MUST NOT alter `liveCounts` or `currentSaturationSegments` (saturation
    // must always be driven by raw MonitoredTicking samples). To be defensive,
    // we temporarily preserve saturation input and restore it after the analysis.
    try {
        // Preserve saturation inputs (no-op restore ensures saturation unchanged)
        const _preservedLiveCounts = (chosen && Array.isArray(chosen.liveCounts)) ? chosen.liveCounts.slice() : [];

        if (chosen && Array.isArray(chosen.allSpawns) && chosen.allSpawns.length > 0) {
            // Only consider named spawns
            const named = chosen.allSpawns.filter(s => s.name !== null && s.name !== undefined);

            const confirmedTicking = new Set();
            const suspectedNonTicking = new Set();

            for (let i = 1; i < named.length; i++) {
                const prev = named[i - 1];
                const curr = named[i];
                const agentName = prev.name;
                if (prev.tick !== null && curr.tick !== null) {
                    if (curr.tick > prev.tick) confirmedTicking.add(agentName);
                    else suspectedNonTicking.add(agentName);
                }
            }

            const initialNonTicking = Array.from(suspectedNonTicking).filter(x => !confirmedTicking.has(x));
            const trueNonTicking = new Set(initialNonTicking.filter(x => !FORCED_VALID_AGENTS.has(x)));

            // Recalculate valid spawn count excluding true non-ticking agents
            let validSpawns = 0;
            for (let sp of chosen.allSpawns) {
                if (!sp.name) { validSpawns++; continue; }
                if (!trueNonTicking.has(sp.name)) validSpawns++;
            }

            chosen.enemySpawns = validSpawns;
            chosen.trueNonTickingAgents = Array.from(trueNonTicking);
        }

        // Restore preserved saturation inputs to guarantee no side-effects
        if (chosen) chosen.liveCounts = _preservedLiveCounts;
    } catch (e) {
        console.warn('Non-ticking agent analysis failed:', e);
    }

    if (chosen && chosen.preciseStartTime !== null) {
        if (chosen.droneTimestamps.length > 0) {
            chosen.startTime = chosen.preciseStartTime;
        }
    }

    return chosen;
}


// --- RENDER ---
function renderDashboard(stats) {
    // Reset saturation segments for each new file to avoid leaking previous data
    currentSaturationSegments = [];
    document.getElementById('missionNodeDisplay').textContent = stats.missionName;

    // --- CHECK IF MIRROR DEFENSE MAP (Saturation Under Maintenance) ---
    let isMirrorDefense = false;
    if (DISABLE_SATURATION_FOR_MIRROR_DEFENSE) {
        isMirrorDefense = MIRROR_DEFENSE_MAPS.some(map => stats.missionName.includes(map));
    }
    // --- END REMOVABLE SECTION ---

    // Determine if this node is a mirror-defense map (e.g. Munio, Tyana)
    const isMirrorNode = Array.isArray(MIRROR_DEFENSE_MAPS) && MIRROR_DEFENSE_MAPS.some(m => stats.missionName.toLowerCase().includes(m.toLowerCase()));

    if (stats.isDefense) {
        missionBadge.textContent = "DEFENSE MISSION";
        missionBadge.style.background = "#ffaa00";
        missionBadge.style.color = "#000";
        if (waveMapPanel) {
            // Hide the Wave Clear Map for mirror-defense nodes to prevent showing an invalid map
            if (isMirrorNode) {
                waveMapPanel.classList.add('hidden');
                const wg = document.getElementById('waveGrid');
                if (wg) wg.innerHTML = "";
            } else {
                waveMapPanel.classList.remove('hidden');
            }
        }
    } else {
        missionBadge.textContent = "INTERCEPTION MISSION";
        missionBadge.style.background = "#ffaa00";
        missionBadge.style.color = "#000";
        if (waveMapPanel) waveMapPanel.classList.add('hidden');
    }

    // KPI: Drones & Manual Input
    document.getElementById('kpiDrones').textContent = stats.droneKills.toLocaleString();
    const totalEnemies = stats.enemySpawns + stats.droneKills;
    document.getElementById('kpiEnemySpawns').textContent = totalEnemies.toLocaleString();

    const updateKillsPerDrone = (droneCount) => {
        if (!droneCount || droneCount <= 0) {
            document.getElementById('kpiKillsPerDrone').textContent = "N/A";
            return;
        }
        const killsPerDrone = totalEnemies / droneCount;
        document.getElementById('kpiKillsPerDrone').textContent = killsPerDrone.toFixed(2);
    };

    updateKillsPerDrone(stats.droneKills);

    const manualInput = document.getElementById('manualDroneInput');
    manualInput.value = "";
    manualInput.oninput = () => {
        const val = parseInt(manualInput.value);
        const countToUse = (isNaN(val) || val < 0) ? stats.droneKills : val;
        updateVitusTable(countToUse, stats.rounds);
        updateKillsPerDrone(countToUse);
    };

    // KPI: Intervals
    let intervals = [];
    if (stats.droneTimestamps.length > 1) {
        for (let i = 1; i < stats.droneTimestamps.length; i++) {
            intervals.push(stats.droneTimestamps[i] - stats.droneTimestamps[i - 1]);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        document.getElementById('kpiDroneInterval').textContent = avgInterval.toFixed(2) + "s";
    } else {
        document.getElementById('kpiDroneInterval').textContent = "N/A";
    }

    // KPI: Run Duration & Pace
    const startTime = stats.startTime || stats.droneTimestamps[0] || 0;
    const endTime = stats.lastActivityTime || 0;
    const durationSeconds = Math.max(0, endTime - startTime);

    if (durationSeconds >= 3600) {
        const durationHours = Math.floor(durationSeconds / 3600);
        const durationMinutes = Math.floor((durationSeconds % 3600) / 60);
        const durationRemainder = Math.floor(durationSeconds % 60);
        document.getElementById('kpiRealDuration').textContent = `${durationHours}h ${durationMinutes}m ${durationRemainder}s`;
    } else {
        const durationMinutes = Math.floor(durationSeconds / 60);
        const durationRemainder = Math.floor(durationSeconds % 60);
        document.getElementById('kpiRealDuration').textContent = `${durationMinutes}m ${durationRemainder}s`;
    }

    // KPI: Duration
    if (stats.isDefense) {
        // Mirror Defense uses 2 waves per rotation; standard Defense uses 3
        const isMirrorNode = Array.isArray(MIRROR_DEFENSE_MAPS) && MIRROR_DEFENSE_MAPS.some(m => stats.missionName.toLowerCase().includes(m.toLowerCase()));
        const wavesPerRotation = isMirrorNode ? 2 : 3;
        document.getElementById('kpiDurationLabel').textContent = "Total Waves";
        document.getElementById('kpiDuration').textContent = stats.rounds * wavesPerRotation;
        document.getElementById('kpiDuration').nextElementSibling.textContent = `(${stats.rounds} Rotations)`;
    } else {
        document.getElementById('kpiDurationLabel').textContent = "Total Rounds";
        document.getElementById('kpiDuration').textContent = stats.rounds;
        document.getElementById('kpiDuration').nextElementSibling.textContent = "Interception Rounds";
    }

    updateVitusTable(stats.droneKills, stats.rounds);

    // --- Saturation (Dynamic Anomaly + Pause Filter + Capacity Logic V2) ---
    let barHTML = "";

    // Mission-aligned window for saturation calculations
    const satStart = startTime || 0;
    const satEnd = endTime || 0;

    // 1. Calculate Mission "Heartbeat" (Median Interval)
    let allIntervals = [];
    if (stats.liveCounts.length > 1) {
        for (let i = 0; i < stats.liveCounts.length - 1; i++) {
            let diff = stats.liveCounts[i + 1].t - stats.liveCounts[i].t;
            if (diff < 30) allIntervals.push(diff);
        }
    }
    allIntervals.sort((a, b) => a - b);
    let median = allIntervals.length > 0 ? allIntervals[Math.floor(allIntervals.length / 2)] : 1.0;

    // 2. Define "Drought Threshold"
    const THRESHOLD = Math.max(1.0, median * 8);

    // 3. Build Graph (Adaptive Resolution)
    if (stats.liveCounts.length > 1) {

        // A. DETERMINE RESOLUTION
        // Defense/Interception (including Mirror Defense): Cap is ~30; use step 3.
        let step = 3;
        let maxVal = 30;
        let numBuckets = Math.ceil(maxVal / step);

        let buckets = new Array(numBuckets).fill(0);
        let totalTime = 0;

        // B. FILL BUCKETS
        for (let i = 0; i < stats.liveCounts.length - 1; i++) {
            let current = stats.liveCounts[i];
            let next = stats.liveCounts[i + 1];

            // Clip segment to mission window so saturation aligns with mission duration
            const segStart = Math.max(current.t, satStart);
            const segEnd = Math.min(next.t, satEnd);
            let duration = segEnd - segStart;

            if (duration <= 0 || duration > 29) continue;

            // Pause Filter
            let isPaused = false;
            if (stats.pauseIntervals) {
                for (let pause of stats.pauseIntervals) {
                    if ((segStart < pause.start && segEnd > pause.end) ||
                        (segStart >= pause.start && segStart < pause.end)) {
                        isPaused = true; break;
                    }
                }
            }
            if (isPaused) continue;

            // Dynamic Index Calculation
            let bucketIndex = Math.floor(current.val / step);
            if (bucketIndex >= numBuckets - 1) bucketIndex = numBuckets - 1; // Clamp to top bucket

            // SATURATION LOGIC & DATA CAPTURE (Defense/Interception)
            buckets[bucketIndex] += duration;
            totalTime += duration;
            currentSaturationSegments.push({ val: current.val, dur: duration });
            updateThresholdStat();
        }

        // C. RENDER BARS (With Adaptive Labels & Gradient)
        buckets.forEach((duration, i) => {
            let start = i * step;
            let end = (i * step) + (step - 1);
            let label = (i === numBuckets - 1) ? `${start}+` : `${start}-${end}`;

            let pct = totalTime > 0 ? (duration / totalTime * 100).toFixed(1) : "0.0";

            let hueStart = 100;
            let hueStep = (stats.isDefense || stats.isInterception) ? 15 : 25;
            let hue = Math.max(0, hueStart - (i * hueStep));

            let lightness = (hue === 0 && i > (numBuckets / 2)) ? "45%" : "50%";

            barHTML += `
            <div class="bar-container">
                <div class="bar-label">${label}</div>
                <div class="bar-track">
                    <div class="bar-fill" style="width:${pct}%; background-color: hsl(${hue}, 100%, ${lightness});"></div>
                </div>
                <div class="bar-value">${pct}%</div>
            </div>`;
        });
        // --- MIRROR DEFENSE MAPS CHECK (Saturation Under Maintenance) ---
        if (isMirrorDefense) {
            document.getElementById('saturationBars').innerHTML = "";
            const satContainer = document.getElementById('saturationStatContainer');
            if (satContainer) {
                satContainer.style.opacity = "0.5";
                satContainer.style.pointerEvents = "none";
                satContainer.style.display = "flex";
                satContainer.style.alignItems = "center";
                satContainer.style.justifyContent = "center";
                satContainer.style.minHeight = "400px";
                satContainer.innerHTML = "<div style='text-align:center; color:#999;'><b>Under Maintenance</b><br><i>Map saturation for Mirror Defense is currently disabled.</i></div>";
            }
        } else {
            document.getElementById('saturationBars').innerHTML = barHTML;
        }
        // --- END REMOVABLE SECTION ---

    } else {
        document.getElementById('saturationBars').innerHTML = "<div style='text-align:center; color:#666; padding:20px;'>No Live data found in log.</div>";
    }

    // Wave Grid
    if (stats.isDefense) {
        let waves = Object.keys(stats.waveStarts).map(Number).sort((a, b) => a - b);
        let waveGridHTML = "";
        if (waves.length > 0) {
            for (let i = 0; i < waves.length; i++) {
                let curr = waves[i];
                let dur = 0;
                if (i < waves.length - 1) {
                    dur = stats.waveStarts[waves[i + 1]] - stats.waveStarts[curr];
                } else {
                    if (stats.lastRewardTime > stats.waveStarts[curr]) {
                        dur = stats.lastRewardTime - stats.waveStarts[curr];
                    } else continue;
                }
                let colorClass = dur > 35 ? 'wave-slow' : 'wave-fast';
                waveGridHTML += `<div class="wave-box ${colorClass}" data-tooltip="Wave ${curr}: ${dur.toFixed(1)}s">${curr}</div>`;
            }
            document.getElementById('waveGrid').innerHTML = waveGridHTML;
        }
    }

    // Packs & Rotation Efficiency (Graph + Grid)
    if (stats.droneTimestamps.length > 1) {
        const graphEl = document.getElementById('packList');

        if (graphEl && graphEl.parentElement) {
            graphEl.parentElement.querySelector('.panel-title').textContent = "Drones Per Minute";
            graphEl.parentElement.querySelector('.panel-desc').textContent = "Line graph for DPM per rotation, alongside average DPM throughout the full run. (Pre-buffing timer is counted for round 1)";
        }

        // 1. Calculate DPM
        let dataPoints = [];
        if (stats.rewardTimestamps && stats.rewardTimestamps.length > 0) {
            // SAFETY: Resolve a reliable start time even when logs miss timestamps
            let startTime = 0;
            if (stats.preciseStartTime) {
                startTime = stats.preciseStartTime;
            } else if (stats.droneTimestamps && stats.droneTimestamps.length > 0) {
                startTime = stats.droneTimestamps[0];
            } else {
                startTime = stats.lastActivityTime ? (stats.lastActivityTime - (stats.rounds * 300)) : 0;
            }

            const totalDuration = Math.max(1, (stats.lastActivityTime || 0) - startTime);
            const minutes = Math.max(0.1, totalDuration / 60);
            let dIdx = 0;

            for (let r = 0; r < stats.rewardTimestamps.length; r++) {
                let endTime = stats.rewardTimestamps[r];
                let count = 0;
                while (dIdx < stats.droneTimestamps.length && stats.droneTimestamps[dIdx] <= endTime) {
                    count++;
                    dIdx++;
                }
                let durationSec = Math.max(endTime - startTime, 10);
                let mins = durationSec / 60;
                dataPoints.push(count / mins);
                startTime = endTime;
            }
        }

        // 2. Render Graph
        if (dataPoints.length > 1) {
            const w = 405, h = 220;
            const margin = { top: 20, right: 20, bottom: 25, left: 35 };
            const graphW = w - margin.left - margin.right;
            const graphH = h - margin.top - margin.bottom;

            const realMin = Math.min(...dataPoints);
            const realMax = Math.max(...dataPoints);
            const minVal = Math.floor(realMin);
            const maxVal = Math.ceil(realMax);
            const range = maxVal - minVal || 1;

            // A. Main Data Line
            let pathD = "";
            dataPoints.forEach((val, i) => {
                const x = (i / (dataPoints.length - 1)) * graphW;
                const normalized = (val - minVal) / range;
                const y = graphH - (normalized * graphH);
                pathD += `${i === 0 ? 'M' : 'L'} ${x},${y} `;
            });

            // B. Average Line
            const avgVal = dataPoints.reduce((a, b) => a + b, 0) / dataPoints.length;
            const avgNorm = (avgVal - minVal) / range;
            const avgY = graphH - (avgNorm * graphH);

            // C. Y-Axis Grid
            let yGridHTML = "";
            let yStep = 1;
            if (stats.isDefense) {
                const yRange = maxVal - minVal;
                if (yRange >= 20) yStep = 5;
                else if (yRange >= 8) yStep = 2;
            }
            for (let v = minVal; v <= maxVal; v++) {
                if ((v - minVal) % yStep !== 0) continue;
                const norm = (v - minVal) / range;
                const y = graphH - (norm * graphH);
                yGridHTML += `
                    <line x1="0" y1="${y}" x2="${graphW}" y2="${y}" stroke="#333" stroke-width="1" />
                    <text x="-5" y="${y}" dy="3" text-anchor="end" fill="#888">${v}</text>
                `;
            }

            // D. X-Axis Labels
            const lastIdx = dataPoints.length - 1;
            let xLabelHTML = "";
            const stride = stats.isDefense ? 5 : 1;
            dataPoints.forEach((_, i) => {
                if (i === 0 || i === lastIdx || (i + 1) % stride === 0) {
                    const x = (i / lastIdx) * graphW;
                    let anchor = i === 0 ? "start" : (i === lastIdx ? "end" : "middle");
                    xLabelHTML += `<text x="${x}" y="${graphH + 15}" text-anchor="${anchor}" fill="#888">${i + 1}</text>`;
                }
            });

            // E. Interactive Points (Hitboxes)
            let pointsHTML = "";
            dataPoints.forEach((val, i) => {
                const x = (i / lastIdx) * graphW;
                const normalized = (val - minVal) / range;
                const y = graphH - (normalized * graphH);

                // Visible Dot
                pointsHTML += `<circle cx="${x}" cy="${y}" r="2" fill="#ffcc33" stroke="none"></circle>`;

                // Invisible Hitbox (Stores data for JS)
                pointsHTML += `<circle class="graph-point" cx="${x}" cy="${y}" r="8" fill="transparent" 
                                data-val="${val.toFixed(1)}" data-rot="${i + 1}" 
                                data-x="${x}" data-y="${y}" style="cursor:pointer;"></circle>`;
            });

            graphEl.outerHTML = `
                <div id="packList" style="width:100%; margin-top:10px; position:relative; flex: 1; display: flex; flex-direction: column;">
                    <svg viewBox="0 0 ${w} ${h}" style="width:100%; height:100%; overflow:visible; font-size:10px; font-family:monospace;">
                        <g transform="translate(${margin.left}, ${margin.top})">
                            ${yGridHTML}
                            <path d="${pathD}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" />
                            <line x1="0" y1="${avgY}" x2="${graphW}" y2="${avgY}" stroke="#ffffff" stroke-width="1" stroke-dasharray="4" opacity="0.9" />
                            <text x="${graphW}" y="${avgY - 6}" text-anchor="end" fill="#ffffff" opacity="1" font-size="11" style="text-shadow: 0px 1px 4px #000;">AVG: ${avgVal.toFixed(1)}</text>
                            ${pointsHTML}
                            ${xLabelHTML}
                        </g>
                    </svg>
                </div>
            `;

            // 3. Attach Custom Tooltip Logic 
            setTimeout(() => {
                const container = document.getElementById('packList');
                if (container) {
                    // Create shared tooltip element
                    const tip = document.createElement('div');
                    tip.style.cssText = "position:absolute; pointer-events:none; background:#000; color:#fff; padding:5px 10px; border:1px solid #555; border-radius:4px; font-size:0.8rem; white-space:nowrap; display:none; transform:translate(-50%, -130%); z-index:100; top:0; left:0;";
                    container.appendChild(tip);

                    // Add Hover Listeners to Hitboxes
                    container.querySelectorAll('.graph-point').forEach(pt => {
                        pt.addEventListener('mouseenter', () => {
                            tip.innerText = `Rotation ${pt.dataset.rot}: ${pt.dataset.val} DPM`;
                            tip.style.display = 'block';
                            tip.style.left = (parseFloat(pt.dataset.x) + margin.left) + 'px';
                            tip.style.top = (parseFloat(pt.dataset.y) + margin.top) + 'px';
                        });
                        pt.addEventListener('mouseleave', () => {
                            tip.style.display = 'none';
                        });
                    });
                }
            }, 0);

        } else {
            graphEl.innerHTML = "<li style='color:#666; justify-content:center;'>Need 2+ rotations for trend graph.</li>";
        }


        // --- B. EFFICIENCY PER ROTATION (PRESERVED) ---
        let dronesPerRound = [];
        let droneIdx = 0;

        if (stats.rewardTimestamps && stats.rewardTimestamps.length > 0) {
            for (let r = 0; r < stats.rewardTimestamps.length; r++) {
                let endTime = stats.rewardTimestamps[r];
                let count = 0;
                while (droneIdx < stats.droneTimestamps.length && stats.droneTimestamps[droneIdx] <= endTime) {
                    count++;
                    droneIdx++;
                }
                dronesPerRound.push(count);
            }
        }

        const listEl = document.getElementById('slowestList');
        if (listEl && listEl.parentElement) {
            const titleEl = listEl.parentElement.querySelector('.panel-title');
            const descEl = listEl.parentElement.querySelector('.panel-desc');
            if (titleEl) titleEl.textContent = "Drones Per Rotation";
            if (descEl) descEl.textContent = "Colors represent relative performance: Red (lowest) → Green (highest).";
        }

        let outputHTML = "";

        if (dronesPerRound.length > 0) {
            const maxVal = Math.max(...dronesPerRound);
            const minVal = Math.min(...dronesPerRound);
            const range = maxVal - minVal || 1;

            const processedData = dronesPerRound.map((count, idx) => {
                let color = '#fff';

                if (count === maxVal) {
                    color = '#00ff22'; // Gold for highest
                } else if (count === Math.max(...dronesPerRound.filter(v => v !== maxVal))) {
                    color = '#00e676'; // Full green for second highest
                } else {
                    // Gradient: interpolate between red (0) and green (1)
                    const normalized = (count - minVal) / range;
                    const hue = normalized * 120; // 0 = red, 120 = green
                    color = `hsl(${hue}, 100%, 50%)`;
                }
                return { count, color, idx };
            });

            if (dronesPerRound.length <= 10) {
                listEl.className = "cumulative-list";
                listEl.style.display = "block";
                processedData.forEach(item => {
                    outputHTML += `<li><span>Round ${item.idx + 1}</span> <span style="color:${item.color}; font-weight:bold;">${item.count}</span></li>`;
                });
            } else {
                listEl.className = "wave-grid";
                listEl.style.display = "grid";
                processedData.forEach(item => {
                    outputHTML += `<div class="wave-box" style="color:${item.color}; background:#333;" data-tooltip="Rotation ${item.idx + 1}">${item.count}</div>`;
                });
            }
        } else {
            outputHTML = "<div style='color:#666; padding:10px; font-size: 0.9em;'>Rotation timestamps not found.</div>";
        }

        listEl.innerHTML = outputHTML;
    }
}
// --- HELPER ---
function updateVitusTable(droneCount, rounds) {
    const p = DROP_CHANCE;
    const meanVal = (4 * RETRIEVER_CHANCE) + (2 * (1 - RETRIEVER_CHANCE));
    const expectValSq = (16 * RETRIEVER_CHANCE) + (4 * (1 - RETRIEVER_CHANCE));
    const varVal = expectValSq - Math.pow(meanVal, 2);
    const rotTotalMean = rounds + (rounds * 0.10 * 3);
    const rotVar = rounds * 0.10 * (1 - 0.10) * 9;
    const meanDrops = droneCount * p;
    const varDrops = droneCount * p * (1 - p);
    const totalDroneMean = meanDrops * meanVal;
    const totalDroneVar = (meanDrops * varVal) + (Math.pow(meanVal, 2) * varDrops);
    const grandMean = rotTotalMean + totalDroneMean;
    const grandStd = Math.sqrt(rotVar + totalDroneVar);
    const tbody = document.querySelector("#vitusTable tbody");
    tbody.innerHTML = "";
    SCENARIOS.forEach(item => {
        const score = Math.round(grandMean + (item.z * grandStd));
        tbody.innerHTML += `<tr><td>${item.prob}</td><td><b>${score.toLocaleString()}</b></td><td>${item.desc}</td></tr>`;
    });

    const userInput = document.getElementById('actualVitusInput');
    const resultDiv = document.getElementById('luckResult');

    if (userInput && userInput.value && resultDiv) {
        const actual = parseFloat(userInput.value);

        const percentile = getNormalCDF(actual, grandMean, grandStd);
        const percentage = (percentile * 100).toFixed(1);

        let color = "#ccc";
        let text = "Average";

        if (percentile >= 0.99) {
            color = "#FFD700"; text = "GOD ROLL";
        } else if (percentile >= 0.90) {
            color = "#00e676"; text = "High Roll";
        } else if (percentile >= 0.75) {
            color = "#b2ff59"; text = "Above Avg";
        } else if (percentile > 0.25) {
            color = "#ccc"; text = "Average";
        } else if (percentile > 0.10) {
            color = "#ffcc80"; text = "Below Avg";
        } else if (percentile > 0.01) {
            color = "#ff9100"; text = "Unlucky";
        } else {
            color = "#ff5252"; text = "WORST CASE";
        }

        resultDiv.style.color = color;
        const displayPercent = percentile > 0.5
            ? `Top ${(100 - percentage).toFixed(1)}%`
            : `Bottom ${percentage}%`;

        resultDiv.innerHTML = `${text} (${displayPercent})`;
    } else if (resultDiv) {
        resultDiv.innerHTML = "Enter amount to see luck %";
        resultDiv.style.color = "#888";
    }
}

// --- DOWNLOAD ---
function generateReportString(stats) {
    if (!stats) return "No analysis data available.";

    let lines = [];

    lines.push(`Mission: ${stats.missionName}`);

    if (stats.isDefense) {
        const isMirrorNode = Array.isArray(MIRROR_DEFENSE_MAPS) && MIRROR_DEFENSE_MAPS.some(m => stats.missionName.toLowerCase().includes(m.toLowerCase()));
        const wavesPerRotation = isMirrorNode ? 2 : 3;
        lines.push(`Waves:   ${stats.rounds * wavesPerRotation} (${stats.rounds} Rotations)`);
    } else {
        lines.push(`Rounds:  ${stats.rounds}`);
    }

    // Handle Manual Override logic for Drones
    const manualInput = document.getElementById('manualDroneInput');
    let droneCount = stats.droneKills;
    if (manualInput && manualInput.value) {
        let val = parseInt(manualInput.value);
        if (!isNaN(val) && val >= 0) droneCount = val;
    }
    lines.push(`Drones:  ${droneCount}`);

    const totalEnemies = stats.enemySpawns + stats.droneKills;
    lines.push(`Total Enemies: ${totalEnemies}`);

    const ratio = droneCount > 0 ? (totalEnemies / droneCount).toFixed(2) : "0.00";
    lines.push(`Enemies/Drone: ${ratio}`);

    const rotations = stats.rounds;
    const isMirrorNode = Array.isArray(MIRROR_DEFENSE_MAPS) && MIRROR_DEFENSE_MAPS.some(m => stats.missionName.toLowerCase().includes(m.toLowerCase()));
    const wavesPerRotation = isMirrorNode ? 2 : 3;
    const rotTotalMean = rotations + (rotations * 0.10 * wavesPerRotation);
    const meanDrops = droneCount * 0.15;
    const meanVal = (4 * 0.18) + (2 * (1 - 0.18));
    const grandMean = rotTotalMean + (meanDrops * meanVal);
    lines.push(`Expected Vitus (50%): ${Math.round(grandMean)}`);

    if (stats.droneTimestamps.length > 1) {
        let intervals = [];
        for (let i = 1; i < stats.droneTimestamps.length; i++) {
            intervals.push(stats.droneTimestamps[i] - stats.droneTimestamps[i - 1]);
        }
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        lines.push(`Avg. Drone Interval:  ${avg.toFixed(2)}s`);
    } else {
        lines.push(`Avg. Drone Interval:  N/A`);
    }

    lines.push("");
    lines.push("--- Enemy Saturation ---");

    // Prefer time-weighted saturation segments (matches dashboard visualization)
    const STEP = 3;
    const MAX_VAL = 30; // top bucket will show `27+`
    const NUM_BUCKETS = Math.ceil(MAX_VAL / STEP);

    if (currentSaturationSegments && currentSaturationSegments.length > 0) {
        let buckets = new Array(NUM_BUCKETS).fill(0);
        let totalDur = 0;

        for (let seg of currentSaturationSegments) {
            let idx = Math.floor(seg.val / STEP);
            if (idx >= NUM_BUCKETS - 1) idx = NUM_BUCKETS - 1; // clamp to top bucket
            buckets[idx] += seg.dur;
            totalDur += seg.dur;
        }

        for (let i = 0; i < NUM_BUCKETS; i++) {
            const start = i * STEP;
            const end = (i * STEP) + (STEP - 1);
            const label = (i === NUM_BUCKETS - 1) ? `${start}+` : `${start}-${end}`;
            const pct = totalDur > 0 ? (buckets[i] / totalDur * 100).toFixed(1) : "0.0";
            lines.push(`${label.padEnd(8)} : ${pct.padStart(5)}%`);
        }

    } else if (stats.liveCounts && stats.liveCounts.length > 0) {
        // Fallback: if segments unavailable, bucket raw samples using same STEP
        let buckets = new Array(NUM_BUCKETS).fill(0);
        stats.liveCounts.forEach(c => {
            let idx = Math.floor(c / STEP);
            if (idx >= NUM_BUCKETS - 1) idx = NUM_BUCKETS - 1;
            buckets[idx]++;
        });
        let total = stats.liveCounts.length;
        for (let i = 0; i < NUM_BUCKETS; i++) {
            const start = i * STEP;
            const end = (i * STEP) + (STEP - 1);
            const label = (i === NUM_BUCKETS - 1) ? `${start}+` : `${start}-${end}`;
            const pct = total > 0 ? (buckets[i] / total * 100).toFixed(1) : "0.0";
            lines.push(`${label.padEnd(8)} : ${pct.padStart(5)}%`);
        }

    } else {
        lines.push("No live enemy count data found.");
    }

    lines.push("");
    lines.push("--- Drones Per Rotation ---");

    if (stats.rewardTimestamps && stats.rewardTimestamps.length > 0) {
        let droneIdx = 0;
        for (let r = 0; r < stats.rewardTimestamps.length; r++) {
            let endTime = stats.rewardTimestamps[r];
            let count = 0;
            while (droneIdx < stats.droneTimestamps.length && stats.droneTimestamps[droneIdx] <= endTime) {
                count++;
                droneIdx++;
            }
            lines.push(`Rotation ${r + 1}: ${count}`);
        }
    } else {
        lines.push("No rotation data available.");
    }

    return lines.join("\n");
}

downloadBtn.onclick = () => {
    if (!currentStats) {
        alert("Please analyze a file first!");
        return;
    }
    const reportText = generateReportString(currentStats);
    const blob = new Blob([reportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    let safeName = currentStats.missionName.replace(/[^a-zA-Z0-9-_ ]/g, "").trim();
    if (!safeName) safeName = "Mission";

    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}_REPORT.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// --- SCREENSHOT FUNCTION ---
async function copyToClipboard() {
    const element = document.getElementById("dashboard");

    const btn = event.currentTarget;
    const originalText = btn.innerHTML;
    btn.innerHTML = "⏳ Generating...";

    try {
        const canvas = await html2canvas(element, {
            scale: 2,
            backgroundColor: "#121212",
            logging: false,
            ignoreElements: (el) => el.id === 'actionButtons',

            onclone: (clonedDoc) => {
                // 1. Handle MANUAL DRONE INPUT
                const manualInput = clonedDoc.getElementById('manualDroneInput');
                if (manualInput) {
                    if (!manualInput.value) {
                        // If empty, hide it for a cleaner report
                        manualInput.parentElement.style.display = "none";
                    } else {
                        // If user typed a number, render a Centered Box
                        const box = clonedDoc.createElement("div");
                        box.innerText = manualInput.value;

                        box.style.cssText = `
                            background: #333; 
                            border: 1px solid #555; 
                            color: white; 
                            border-radius: 4px; 
                            width: 80%; 
                            margin: 0 auto; 
                            height: 23px;
                            padding: 5px; 
                            font-weight: bold; 
                            font-size: 1.2rem; 
                            text-align: center;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                        `;

                        manualInput.parentNode.replaceChild(box, manualInput);
                    }
                }

                const vitusInput = clonedDoc.getElementById('actualVitusInput');
                if (vitusInput) {
                    const box = clonedDoc.createElement("div");
                    box.innerText = vitusInput.value || "-";

                    box.style.cssText = `
                        background: #1a1a1a; 
                        border: 1px solid #444; 
                        color: #fff; 
                        border-radius: 4px; 
                        width: 70px; 
                        padding: 5px 0;
                        text-align: center; 
                        font-weight: bold; 
                        display: inline-block;
                    `;
                    vitusInput.parentNode.replaceChild(box, vitusInput);
                }

                // 3. Handle SATURATION INPUT - Clean Visual for Screenshot
                const saturationContainer = clonedDoc.getElementById('saturationStatContainer');
                const saturationInput = clonedDoc.getElementById('saturationThreshold');
                const resultText = clonedDoc.getElementById('thresholdResult');

                if (saturationContainer && saturationInput && resultText) {
                    const val = saturationInput.value || 15;
                    const pctText = resultText.innerText;
                    
                    const cleanBox = clonedDoc.createElement("div");
                    
                    cleanBox.style.cssText = `
                        margin-top: 15px;
                        padding: 12px;
                        background: rgba(255, 255, 255, 0.05);
                        border-radius: 4px;
                        border: 1px solid #444;
                        font-family: 'Inter', sans-serif;
                    `;
                    
                    const gradientColor = getGradientColor(parseFloat(pctText.replace('%', '')));
                    cleanBox.innerHTML = `
                        <div style="color: #ccc; font-size: 0.85rem; margin-bottom: 5px;">
                            % of total time spent with <b style="color:#fff;">${val}</b> or more enemies alive:
                        </div>
                        <div style="color: #ccc; font-weight: bold; font-size: 1.6rem;">
                            <span style="color: ${gradientColor};">${pctText}</span>
                        </div>
                    `;
                    
                    saturationContainer.parentNode.replaceChild(cleanBox, saturationContainer);
                }

                // Add watermark at bottom
                const watermark = clonedDoc.createElement("div");
                watermark.style.cssText = `
                    text-align: center;
                    color: #7a7a7a;
                    font-size: 1.1rem;
                    margin-top: 2px;
                    margin-bottom: 20px;
                    padding-top: 1px;
                    padding-bottom: 12px;
                    border-top: 1px solid #333;
                    opacity: 0.9;
                    line-height: 1.9;
                `;
                watermark.innerHTML = "Made by @sves<br>https://svesk.github.io/arbi/";
                clonedDoc.getElementById("dashboard").appendChild(watermark);
            }
        });

        canvas.toBlob(async (blob) => {
            try {
                const item = new ClipboardItem({ "image/png": blob });
                await navigator.clipboard.write([item]);
                btn.innerHTML = "✅ Copied!";
                setTimeout(() => { btn.innerHTML = originalText; }, 2000);
            } catch (err) {
                console.error(err);
                alert("Browser blocked clipboard access. Try using Chrome/Edge.");
                btn.innerHTML = originalText;
            }
        });

    } catch (err) {
        console.error("Screenshot failed:", err);
        alert("Failed to generate image.");
        btn.innerHTML = originalText;
    }
}

function getNormalCDF(x, mean, std) {
    const z = (x - mean) / std;
    let t = 1 / (1 + 0.2316419 * Math.abs(z));
    let d = 0.3989423 * Math.exp(-z * z / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (z > 0) p = 1 - p;
    return p;
}

// Helper function to get color gradient from green (0%) to red (50%)
function getGradientColor(percent) {
    // Clamp percent between 0 and 100
    percent = Math.max(0, Math.min(100, percent));
    
    // Hue goes from 120 (green) to 0 (red) on the HSL wheel, reaching red at 50%
    const hue = Math.max(0, 120 - (percent / 18) * 120);
    return `hsl(${hue}, 100%, 50%)`;
}

const actualInput = document.getElementById('actualVitusInput');
if (actualInput) {
    actualInput.oninput = () => {
        if (!currentStats) return;

        const manualBox = document.getElementById('manualDroneInput');
        let activeDroneCount = currentStats.droneKills;

        if (manualBox && manualBox.value !== "") {
            const val = parseInt(manualBox.value);
            if (!isNaN(val) && val >= 0) {
                activeDroneCount = val;
            }
        }

        updateVitusTable(activeDroneCount, currentStats.rounds);
    };
}

// --- NEW FEATURE: Saturation Threshold Logic ---
function updateThresholdStat() {
    const thresholdResult = document.getElementById('thresholdResult');

    // Safety Check
    if (!currentSaturationSegments || currentSaturationSegments.length === 0) {
        if (thresholdResult) thresholdResult.textContent = "--%";
        return;
    }

    // Always use 15 as the limit
    const limit = 15;

    // 3. Calculate % time above limit
    let totalDur = 0;
    let aboveDur = 0;

    for (let seg of currentSaturationSegments) {
        totalDur += seg.dur;
        if (seg.val >= limit) {
            aboveDur += seg.dur;
        }
    }

    // 4. Update Result
    let pct = totalDur > 0 ? (aboveDur / totalDur * 100).toFixed(1) : "0.0";

    if (thresholdResult) {
        thresholdResult.textContent = `${pct}%`;
        thresholdResult.style.color = getGradientColor(parseFloat(pct));
    }
}
