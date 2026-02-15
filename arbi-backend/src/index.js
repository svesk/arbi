
const ALLOWED_ORIGINS = [
    "https://svesk.github.io", 
    "http://127.0.0.1:5500",   
    "http://localhost:5500"
];

function sanitizeText(str, maxLength) {
    if (!str) return "";
    return String(str).replace(/[<>]/g, "").trim().substring(0, maxLength);
}

async function generateRunHash(data) {
    const rawString = `${data.missionName}-${data.roundsCompleted}-${data.droneKills}-${data.totalEnemies}-${data.durationSeconds}`;
    const msgUint8 = new TextEncoder().encode(rawString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin");
        const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin);
        
        const corsHeaders = {
            "Access-Control-Allow-Origin": isAllowedOrigin ? origin : "https://svesk.github.io",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
        }

        if (!isAllowedOrigin) {
            return new Response(JSON.stringify({ error: "Forbidden origin" }), { status: 403, headers: corsHeaders });
        }

        try {

            const data = await request.json();

            if (typeof data.roundsCompleted !== 'number' || data.roundsCompleted < 10) {
                return new Response(JSON.stringify({ error: "Run must be at least 10 rounds." }), { status: 400, headers: corsHeaders });
            }
            if (typeof data.droneKills !== 'number' || data.droneKills < 500) {
                return new Response(JSON.stringify({ error: "Run must have at least 500 drone kills." }), { status: 400, headers: corsHeaders });
            }
            if (typeof data.durationSeconds !== 'number' || data.durationSeconds < 600) {
                return new Response(JSON.stringify({ error: "Run duration is too short." }), { status: 400, headers: corsHeaders });
            }

            if (typeof data.actualVitus !== 'number' || data.actualVitus < 0) {
                return new Response(JSON.stringify({ error: "Actual Vitus is strictly required and must be a positive number." }), { status: 400, headers: corsHeaders });
            }

            const cleanAlias = sanitizeText(data.playerAlias, 25); 
            const cleanNotes = sanitizeText(data.notes, 200);      
            const runHash = await generateRunHash(data);

            const { success } = await env.DB.prepare(`
                INSERT INTO runs (
                    run_hash, player_alias, notes, mission_name, is_defense, rounds_completed, 
                    drone_kills, total_enemies, duration_seconds, actual_vitus, 
                    expected_vitus, luck_percentile, avg_drone_interval, 
                    threshold_saturation_percent, saturation_buckets, drones_per_rotation
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                runHash, cleanAlias, cleanNotes, data.missionName, 
                data.isDefense ? 1 : 0, data.roundsCompleted, data.droneKills, 
                data.totalEnemies, data.durationSeconds, data.actualVitus, 
                data.expectedVitus, data.luckPercentile, data.avgDroneInterval, 
                data.thresholdSaturationPercent, 
                JSON.stringify(data.saturationBuckets), 
                JSON.stringify(data.dronesPerRotation)
            ).run();

            return new Response(JSON.stringify({ message: "Run uploaded successfully!" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });

        } catch (error) {
            if (error.message.includes("UNIQUE constraint failed")) {
                return new Response(JSON.stringify({ error: "This run has already been uploaded." }), {
                    status: 409, 
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            return new Response(JSON.stringify({ error: "Invalid data format or server error." }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }
    }
};