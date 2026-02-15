DROP TABLE IF EXISTS runs;

CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_hash TEXT UNIQUE,
    player_alias TEXT,
    notes TEXT,
    mission_name TEXT,
    is_defense BOOLEAN,
    rounds_completed INTEGER,
    drone_kills INTEGER,
    total_enemies INTEGER,
    duration_seconds REAL,
    actual_vitus INTEGER,
    expected_vitus INTEGER,
    luck_percentile REAL,
    avg_drone_interval REAL,
    threshold_saturation_percent REAL,
    saturation_buckets TEXT, 
    drones_per_rotation TEXT, 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);