// --- CONSTANTS ---
const DROP_CHANCE = 0.15;
const RETRIEVER_CHANCE = 0.18;
const SCENARIOS = [
    { z: -2.326, prob: "99%", desc: "Worst Case" },
    { z: -1.282, prob: "90%", desc: "Unlucky" },
    { z: -0.674, prob: "75%", desc: "Below Avg" },
    { z: 0.000,  prob: "50%", desc: "Average" },
    { z: 0.674,  prob: "25%", desc: "Above Avg" },
    { z: 1.282,  prob: "10%", desc: "High Roll" },
    { z: 2.326,  prob: " 1%", desc: "God Roll" }
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
        const text = await readAndCleanFile(file);
        const stats = analyzeLogData(text);
        currentStats = stats;
        renderDashboard(stats);
        
        dashboard.classList.remove('hidden');
        spinner.style.display = 'none';
        statusDiv.textContent = "";
        uploadSection.style.marginBottom = "0px";
        document.querySelector('.subtitle').style.display = 'none';

    } catch (error) {
        console.error(error);
        statusDiv.textContent = "Error: " + error.message;
        statusDiv.style.color = "red";
        spinner.style.display = 'none';
        dropZone.style.display = 'block';
    }
}

// --- CLEANER & OPTIMIZER ---
async function readAndCleanFile(file) {
    const CHUNK_SIZE = 1024 * 1024 * 10; // Read 10MB chunks
    const SPAM = ["Game [Warning]:", "DamagePct exceeds limits"]; // Lines to strip
    let offset = 0, fullContent = "", leftover = "";
    
    // 1. Read the file
    while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const text = await slice.text();
        const currentData = leftover + text;
        
        let lastIdx = currentData.lastIndexOf('\n');
        let chunk = lastIdx !== -1 && (offset + CHUNK_SIZE < file.size) ? currentData.substring(0, lastIdx) : currentData;
        leftover = lastIdx !== -1 && (offset + CHUNK_SIZE < file.size) ? currentData.substring(lastIdx + 1) : "";

        const lines = chunk.split('\n');
        for (let line of lines) {
            let isSpam = false;
            for(let s of SPAM) if(line.includes(s)) { isSpam=true; break; }
            if (!isSpam) fullContent += line + '\n';
        }
        offset += CHUNK_SIZE;
        
        // Progress Bar
        let pct = Math.min(100, (offset/file.size)*100).toFixed(0);
        statusDiv.textContent = `Reading... ${pct}%`;
        await new Promise(r => setTimeout(r, 0));
    }

    // 2. THE OPTIMIZATION (Ported from Python)
    // Find the LAST mission start to avoid processing old data
    const lastStartRegex = /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name: (.*)/g;
    let match;
    let lastIndex = -1;

    // Loop through to find the very last occurrence
    while ((match = lastStartRegex.exec(fullContent)) !== null) {
        // Only care if it's an Arbitration
        if (match[1].includes("Arbitration")) {
            lastIndex = match.index;
        }
    }

    // If we found a valid run, discard everything before it
    if (lastIndex !== -1) {
        console.log("Optimizing: Truncating log to last Arbitration run at index", lastIndex);
        return fullContent.substring(lastIndex);
    }

    return fullContent;
}

// --- ANALYZER ---
function analyzeLogData(text) {
    const lines = text.split(/\r?\n/);
    let sessions = [];

    const createStats = () => ({
        droneKills: 0,
        enemySpawns: 0, // NEW: Track total enemies
        rounds: 0,
        isDefense: false,
        droneTimestamps: [],
        rewardTimestamps: [],
        waveStarts: {},
        liveCounts: [],
        lastRewardTime: 0,
        missionName: "Unknown Node",
        hasData: false,
        lastActivityTime: 0 
    });

    let current = createStats();

    // Regex Patterns
    const p_overlay = /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name: (.*)/;
    const p_agent = /OnAgentCreated/;
    const p_drone = /OnAgentCreated.*?CorpusEliteShieldDroneAgent/;
    // Turret Filter (Matches Python logic exactly)
    const p_turret = /OnAgentCreated.*?(?:\/Npc\/)?AutoTurretAgentShipRemaster/; 
    
    const p_reward = /^(\d+\.\d+).*Sys \[Info\]: Created \/Lotus\/Interface\/DefenseReward\.swf/;
    const p_defWave = /WaveDefend\.lua: Defense wave: 1/;
    const p_waveLine = /^(\d+\.\d+).*Script \[Info\]: WaveDefend\.lua: Starting wave (\d+)/;
    const p_waveDef = /^(\d+\.\d+).*WaveDefend\.lua: Defense wave: (\d+)/; 
    const p_live = /AI \[Info\]:.*?Live (\d+)/;
    const p_timestamp = /^(\d+\.\d+)/;

    for (let line of lines) {
        // 1. Get Timestamp
        let timestamp = 0;
        const tsMatch = line.match(p_timestamp);
        if (tsMatch) timestamp = parseFloat(tsMatch[1]);

        // 2. MISSION START (ThemedSquadOverlay)
        const mMission = line.match(p_overlay);
        if (mMission) {
            let name = mMission[1].trim();
            if (name.includes("Arbitration")) {
                if (timestamp > 0 && current.lastActivityTime > 0 && timestamp < current.lastActivityTime) {
                    continue; 
                }
                if (current.hasData || current.missionName !== "Unknown Node") {
                    sessions.push(current);
                }
                current = createStats();
                current.missionName = name.replace("Arbitration:", "").trim();
                if (timestamp) current.lastActivityTime = timestamp;
            }
            continue; 
        }

        // 3. GAMEPLAY DATA
        
        // Track Drones
        if (p_drone.test(line)) {
            current.droneKills++;
            current.hasData = true;
            if (timestamp) {
                current.droneTimestamps.push(timestamp);
                current.lastActivityTime = Math.max(current.lastActivityTime, timestamp);
            }
            // Note: Drones are technically "Agents", so we count them here,
            // but usually we want "Enemy Spawns" to be non-drones? 
            // The Python script counts them as both. 
            // If you want "Non-Drone Enemies", use the else if below.
        }
        
        // NEW: Track Enemies (excluding Drones and Turrets)
        // This ensures "Total Enemies" is clean data.
        else if (p_agent.test(line)) {
            if (!p_turret.test(line)) {
                current.enemySpawns++;
            }
        }

        // Track Rewards
        const mReward = line.match(p_reward);
        if (mReward) {
            current.rounds++;
            current.hasData = true;
            if (timestamp) {
                current.lastRewardTime = timestamp;
                current.rewardTimestamps.push(timestamp);
                current.lastActivityTime = Math.max(current.lastActivityTime, timestamp);
            }
        }

        // Track Waves
        if (p_defWave.test(line)) current.isDefense = true;
        let mWave = line.match(p_waveLine);
        if (!mWave) mWave = line.match(p_waveDef);
        if (mWave && timestamp) {
            current.waveStarts[parseInt(mWave[2])] = timestamp;
            current.lastActivityTime = Math.max(current.lastActivityTime, timestamp);
        }

// Track Live Counts (Cleaned: Live - AllyLive)
        // We capture both the Total Live count and the AllyLive count
        const p_liveComplex = /AI \[Info\]:.*?Live (\d+).*?AllyLive (\d+)/;
        const mLive = line.match(p_liveComplex);
        
        if (mLive && timestamp) {
            let total = parseInt(mLive[1]);
            let allies = parseInt(mLive[2]);
            
            // The Holy Grail: True Enemy Count
            let trueEnemies = Math.max(0, total - allies);
            
            current.liveCounts.push({ t: timestamp, val: trueEnemies });
        }
    }

    if (current.hasData || current.missionName !== "Unknown Node") {
        sessions.push(current);
    }

    // Filter Best Session
    let bestSession = null;
    for (let i = sessions.length - 1; i >= 0; i--) {
        const s = sessions[i];
        if (s.rounds > 0 && s.droneKills > 20) {
            bestSession = s;
            break; 
        }
    }

    return bestSession || sessions[sessions.length - 1] || createStats();
}


// --- RENDER ---
function renderDashboard(stats) {
    document.getElementById('missionNodeDisplay').textContent = stats.missionName;
    
    if (stats.isDefense) {
        missionBadge.textContent = "DEFENSE MISSION";
        missionBadge.style.background = "#ffaa00";
        missionBadge.style.color = "#000";
        sectionWaveMap.classList.remove('hidden');
    } else {
        missionBadge.textContent = "INTERCEPTION MISSION";
        missionBadge.style.background = "#ffaa00";
        missionBadge.style.color = "#000";
        sectionWaveMap.classList.add('hidden');
    }

    // KPI: Drones & Manual Input
    document.getElementById('kpiDrones').textContent = stats.droneKills.toLocaleString();
    
    const manualInput = document.getElementById('manualDroneInput');
    manualInput.value = ""; 
    manualInput.oninput = () => {
        const val = parseInt(manualInput.value);
        const countToUse = (isNaN(val) || val < 0) ? stats.droneKills : val;
        updateVitusTable(countToUse, stats.rounds);
    };

    // KPI: Intervals
    let intervals = [];
    if (stats.droneTimestamps.length > 1) {
        for (let i = 1; i < stats.droneTimestamps.length; i++) {
            intervals.push(stats.droneTimestamps[i] - stats.droneTimestamps[i-1]);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        document.getElementById('kpiDroneInterval').textContent = avgInterval.toFixed(2) + "s";
    } else {
        document.getElementById('kpiDroneInterval').textContent = "N/A";
    }

    // KPI: Duration
    if (stats.isDefense) {
        document.getElementById('kpiDurationLabel').textContent = "Total Waves";
        document.getElementById('kpiDuration').textContent = stats.rounds * 3;
        document.getElementById('kpiDuration').nextElementSibling.textContent = `(${stats.rounds} Rotations)`;
    } else {
        document.getElementById('kpiDurationLabel').textContent = "Total Rounds";
        document.getElementById('kpiDuration').textContent = stats.rounds;
        document.getElementById('kpiDuration').nextElementSibling.textContent = "Interception Rounds";
    }

    updateVitusTable(stats.droneKills, stats.rounds);
// --- Saturation (Dynamic Anomaly Detection) ---
    let barHTML = "";
    let buckets = new Array(11).fill(0);
    let totalTime = 0;

    // 1. Calculate the Mission's "Heartbeat" (Median Interval)
    // This finds the standard spawn rate for THIS specific run.
    let allIntervals = [];
    if (stats.liveCounts.length > 1) {
        for (let i = 0; i < stats.liveCounts.length - 1; i++) {
            let diff = stats.liveCounts[i+1].t - stats.liveCounts[i].t;
            if (diff < 30) allIntervals.push(diff); // Filter massive outliers
        }
    }
    allIntervals.sort((a, b) => a - b);
    let median = allIntervals.length > 0 ? allIntervals[Math.floor(allIntervals.length / 2)] : 1.0;

    // 2. Define "Drought Threshold" (Median * 3)
    // Anything 3x longer than the median is considered a "Game Nap" / "Map Clear".
    const THRESHOLD = Math.max(1.0, median * 3);

    // 3. Build the Graph
    if (stats.liveCounts.length > 1) {
        for (let i = 0; i < stats.liveCounts.length - 1; i++) {
            let current = stats.liveCounts[i];
            let next = stats.liveCounts[i+1];
            let duration = next.t - current.t;
            
            if (duration > 60) continue; // Ignore pauses

            let bucketIndex = current.val >= 50 ? 10 : Math.floor(current.val / 5);

            if (duration > THRESHOLD) {
                // Game went silent longer than expected.
                // Credit active time up to the threshold...
                buckets[bucketIndex] += THRESHOLD;
                totalTime += THRESHOLD;

                // ...and mark the rest as "Spawn Drought" (Bucket 0)
                let droughtDuration = duration - THRESHOLD;
                buckets[0] += droughtDuration; 
                totalTime += droughtDuration;
            } else {
                // Normal gap. Map remained saturated.
                buckets[bucketIndex] += duration;
                totalTime += duration;
            }
        }
        
        // Render the bars
        buckets.forEach((duration, i) => {
            let label = i===10 ? "50+" : `${i*5}-${i*5+4}`;
            let pct = totalTime > 0 ? (duration / totalTime * 100).toFixed(1) : "0.0";
            barHTML += `<div class="bar-container"><div class="bar-label">${label}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="bar-value">${pct}%</div></div>`;
        });
        document.getElementById('saturationBars').innerHTML = barHTML;
        
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
                    dur = stats.waveStarts[waves[i+1]] - stats.waveStarts[curr];
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
// --- A. HOST STABILITY GRAPH (DPM TREND) ---
        const graphEl = document.getElementById('packList');
        
        if (graphEl && graphEl.parentElement) {
            graphEl.parentElement.querySelector('.panel-title').textContent = "Drones Per Minute";
            graphEl.parentElement.querySelector('.panel-desc').textContent = "Line graph for DPM per rotations, alongside average DPM throughout the full run. (Pre-buffing timer is counted for round 1)";
        }

        // 1. Calculate DPM
        let dataPoints = [];
        if (stats.rewardTimestamps && stats.rewardTimestamps.length > 0) {
            let startTime = stats.droneTimestamps[0]; 
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
            const avgVal = dataPoints.reduce((a,b)=>a+b,0) / dataPoints.length;
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
                    xLabelHTML += `<text x="${x}" y="${graphH + 15}" text-anchor="${anchor}" fill="#888">${i+1}</text>`;
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
                                data-val="${val.toFixed(1)}" data-rot="${i+1}" 
                                data-x="${x}" data-y="${y}" style="cursor:pointer;"></circle>`;
            });

            graphEl.outerHTML = `
                <div id="packList" style="width:100%; height:260px; margin-top:10px; position:relative;">
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
                if(container) {
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
            if(titleEl) titleEl.textContent = "Drones Per Rotation";
            if(descEl) descEl.textContent = "Green = Higher than previous. Red = Lower.";
        }

        let outputHTML = "";
        
        if (dronesPerRound.length > 0) {
            const maxVal = Math.max(...dronesPerRound);

            const processedData = dronesPerRound.map((count, idx) => {
                let color = '#fff'; 
                
                if (count === maxVal) {
                    color = '#FFD700'; 
                }
                else if (idx > 0) {
                    let prev = dronesPerRound[idx-1];
                    if (count > prev) color = 'var(--success)';
                    else if (count < prev) color = 'var(--danger)'; 
                }
                return { count, color, idx };
            });

            if (dronesPerRound.length <= 10) {
                listEl.className = "cumulative-list";
                listEl.style.display = "block";
                processedData.forEach(item => {
                    outputHTML += `<li><span>Round ${item.idx+1}</span> <span style="color:${item.color}; font-weight:bold;">${item.count}</span></li>`;
                });
            } else {
                listEl.className = "wave-grid";
                listEl.style.display = "grid"; 
                processedData.forEach(item => {
                    outputHTML += `<div class="wave-box" style="color:${item.color}; background:#333;" data-tooltip="Rotation ${item.idx+1}">${item.count}</div>`;
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
    const rotTotalMean = rounds + (rounds * 0.07 * 3);
    const rotVar = rounds * 0.07 * (1 - 0.07) * 9;
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
            color = "#ccc";    text = "Average";        
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
        lines.push(`Waves:   ${stats.rounds * 3} (${stats.rounds} Rotations)`);
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

    // --- NEW: Total Enemies & Ratio ---
    // We use the tracked 'enemySpawns' + 'droneKills' if you want "Total Spawns",
    // OR just 'enemySpawns' if you want "Non-Drone Enemies".
    // Based on typical user needs, "Total Enemies" usually implies Everything minus Turrets.
    const totalEnemies = stats.enemySpawns + stats.droneKills; 
    lines.push(`Total Enemies: ${totalEnemies}`);
    
    const ratio = droneCount > 0 ? (totalEnemies / droneCount).toFixed(2) : "0.00";
    lines.push(`Enemies/Drone: ${ratio}`);
    // ----------------------------------

    const rotations = stats.rounds; 
    const rotTotalMean = rotations + (rotations * 0.07 * 3);
    const meanDrops = droneCount * 0.15; 
    const meanVal = (4 * 0.18) + (2 * (1 - 0.18)); 
    const grandMean = rotTotalMean + (meanDrops * meanVal);
    lines.push(`Expected Vitus (50%): ${Math.round(grandMean)}`);

    if (stats.droneTimestamps.length > 1) {
        let intervals = [];
        for (let i = 1; i < stats.droneTimestamps.length; i++) {
            intervals.push(stats.droneTimestamps[i] - stats.droneTimestamps[i-1]);
        }
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        lines.push(`Avg. Drone Interval:  ${avg.toFixed(2)}s`);
    } else {
        lines.push(`Avg. Drone Interval:  N/A`);
    }

    lines.push("");
    lines.push("--- Enemy Saturation ---");
    
    if (stats.liveCounts.length > 0) {
        let buckets = new Array(11).fill(0);
        stats.liveCounts.forEach(c => buckets[c >= 50 ? 10 : Math.floor(c/5)]++);
        let total = stats.liveCounts.length;
        for (let i = 0; i < 11; i++) {
            let label = (i === 10) ? "50+" : `${i*5}-${(i*5)+4}`;
            let pct = (buckets[i] / total * 100).toFixed(1);
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
            lines.push(`Rotation ${r+1}: ${count}`);
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
    if(!safeName) safeName = "Mission";
    
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
                        // If empty, still hide it for a cleaner report
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

const actualInput = document.getElementById('actualVitusInput');
if(actualInput) {
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