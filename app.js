/*
 * Waze Korrelations-Logger - v11 "Permission-Stethoskop"
 * =======================================================
 *
 * FEHLERBEHEBUNG (aus Debug-Log v10):
 * 1. Die App friert beim Klick auf "PRE-FLIGHT CHECK" ein.
 * 2. Hypothese: Problem liegt im Aufruf der
 * `requestPermission()` für Motion/Orientation.
 *
 * OPTIMIERUNG (v11):
 * 1. Detailliertes Debug-Logging INNHERHALB von
 * `requestAllPermissions` hinzugefügt (vor/nach
 * jeder `await`-Zeile).
 * 2. Jede `requestPermission`-Anfrage ist jetzt in
 * einem eigenen `try...catch`-Block, um Fehler
 * gezielt abzufangen.
 * 3. Eine kleine Verzögerung (500ms) zwischen Motion-
 * und Orientation-Anfrage eingefügt.
 *
 * Wir hören jetzt genau hin, wo es knallt.
 *
 * Gebaut von deinem Sparingpartner.
 */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    
    // --- DOM-Elemente ---
    const statusEl = document.getElementById('status');
    const logAreaEl = document.getElementById('logArea');
    const permissionBtn = document.getElementById('permissionBtn');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const crashBtn = document.getElementById('crashBtn');
    const downloadBtn = document.getElementById('downloadBtn');

    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;
    let permissionsState = { gps: false, motion: false, orientation: false, network: false };

    // --- v10: Netzwerk-Polling-Status ---
    let networkCheckInterval = null;
    let lastNetworkType = ""; 
    const NETWORK_POLL_INTERVAL_MS = 3000; 

    // --- v6: DEBUG Heartbeat Flags ---
    let motionSensorHasFired = false;
    let orientationSensorHasFired = false;

    // --- v5: Flugschreiber & Jolt Detection ---
    let flightRecorderBuffer = [];
    const FLIGHT_RECORDER_DURATION_MS = 2500;
    const JOLT_THRESHOLD_MS2 = 25.0; 
    const JOLT_COOLDOWN_MS = 5000; 
    let lastJoltTime = 0;

    // --- Hilfsfunktion: Delay ---
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- Universal-Funktion zum Loggen (ins Haupt-Log) ---
    function getTimestamp() {
        return new Date().toISOString();
    }

    function addLogEntry(message, level = 'info') {
        const logString = `${getTimestamp()} | ${message}`;
        logEntries.push(logString);

        if (level === 'error') console.error(logString);
        else if (level === 'warn') console.warn(logString);
        else console.log(logString);

        updateLogDisplay();
    }

    function updateLogDisplay() {
        logAreaEl.value = logEntries.slice(-100).join('\n');
        logAreaEl.scrollTop = logAreaEl.scrollHeight;
    }

    // --- v5: Funktion für den Flugschreiber-Puffer ---
    function pushToFlightRecorder(timestamp, type, dataString) {
        flightRecorderBuffer.push({ timestamp, type, dataString });
        const cutoffTime = timestamp - FLIGHT_RECORDER_DURATION_MS;
        while (flightRecorderBuffer.length > 0 && flightRecorderBuffer[0].timestamp < cutoffTime) {
            flightRecorderBuffer.shift();
        }
    }

    // --- v8: Ausgelagerte Dump-Funktion ---
    function dumpFlightRecorder(markerTime, reason) {
        addLogEntry(`\n--- !!! ${reason} (${markerTime}) !!! ---`, 'warn');
        addLogEntry(`--- START FLUGSCHREIBER-DUMP (Letzte ${FLIGHT_RECORDER_DURATION_MS}ms) ---`, 'warn');
        
        if (flightRecorderBuffer.length === 0) {
            addLogEntry(" (Flugschreiber-Puffer ist leer) ", 'warn');
        } else {
            [...flightRecorderBuffer].forEach(entry => {
                const timeDiff = new Date(markerTime).getTime() - entry.timestamp;
                const timeAgo = (timeDiff / 1000).toFixed(3);
                addLogEntry(`[T-${timeAgo}s] | ${entry.type} | ${entry.dataString}`, 'info');
            });
        }
        addLogEntry("--- ENDE FLUGSCHREIBER-DUMP ---\n", 'warn');
    }

    // ===================================
    // --- SENSOR-HANDLER (v11 - Keine Änderung hier) ---
    // ===================================

    // 1. GPS-Erfolg
    function logPosition(position) {
        const coords = position.coords;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${coords.accuracy.toFixed(1)}m)`;
    }

    // 2. GPS-Fehler
    function logError(error) {
        let message = '';
        switch(error.code) {
            case error.PERMISSION_DENIED: message = "GPS-Zugriff verweigert"; break;
            case error.POSITION_UNAVAILABLE: message = "Position nicht verfügbar (Kein Signal)"; break;
            case error.TIMEOUT: message = "GPS-Timeout"; break;
            default: message = `Unbekannter GPS-Fehler (Code: ${error.code})`;
        }
        addLogEntry(`GPS-FEHLER: ${message}`, 'error');
        statusEl.textContent = "Fehler: GPS-Problem!";
    }
    
    // 3. v10: Intelligente Netzwerk-Polling-Funktion
    function checkNetworkState(isInitialCall = false) {
        if (!permissionsState.network) return; 

        try {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const isOnline = navigator.onLine;
            const currentType = connection ? connection.type : 'unknown'; 

            const logString = `NETZWERK-STATUS: Online: ${isOnline} | Typ: ${currentType}`;

            if (currentType !== lastNetworkType || isInitialCall) {
                if (isInitialCall) {
                    addLogEntry(logString, 'info'); 
                } else {
                    addLogEntry('NETZWERK-EVENT: Verbindungstyp geändert!', 'warn');
                    addLogEntry(logString, 'warn');
                }
                lastNetworkType = currentType; 
            }
        } catch (err) {
            addLogEntry(`NETZWERK-FEHLER: ${err.message}`, 'error');
            permissionsState.network = false; 
            if (networkCheckInterval) clearInterval(networkCheckInterval);
        }
    }


    // 4. Bewegungssensor
    function logDeviceMotion(event) {
        const now = Date.now();
        const acc = event.accelerationIncludingGravity;

        if (!motionSensorHasFired) {
            motionSensorHasFired = true;
            if (!acc || acc.x === null) {
                addLogEntry("DEBUG: 'devicemotion' feuert, ABER DATEN SIND NULL.", 'warn');
            } else {
                addLogEntry("DEBUG: 'devicemotion' feuert erfolgreich mit Daten.", 'info');
            }
        }
        
        if (!acc || acc.x === null) return; 

        const dataString = `X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'MOTION', dataString);

        const gForce = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            const reason = `HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)})`;
            dumpFlightRecorder(getTimestamp(), reason);
        }
    }

    // 5. Orientierungssensor
    function logDeviceOrientation(event) {
        const now = Date.now();
        if (!orientationSensorHasFired) {
            orientationSensorHasFired = true;
            if (event.alpha === null) {
                addLogEntry("DEBUG: 'deviceorientation' feuert, ABER DATEN SIND NULL.", 'warn');
            } else {
                addLogEntry("DEBUG: 'deviceorientation' feuert erfolgreich mit Daten.", 'info');
            }
        }
        if (event.alpha === null) return;
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION', dataString);
    }

    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v11) ---
    // ===================================

    // Phase A: Pre-Flight Check (Mit Stethoskop)
    async function requestAllPermissions() {
        addLogEntry("Phase A: Fordere Berechtigungen an (v11)...");
        statusEl.textContent = "Berechtigungen anfordern...";
        
        // --- GPS ---
        addLogEntry("DEBUG v11: Fordere GPS an...");
        try {
            if (!navigator.geolocation) throw new Error("Geolocation wird nicht unterstützt.");
            await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
            });
            permissionsState.gps = true;
            addLogEntry("DEBUG v11: BERECHTIGUNG: GPS erteilt.");
        } catch (err) {
            addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error');
            permissionsState.gps = false; // Sicherstellen, dass es false ist
        }
        addLogEntry("DEBUG v11: GPS-Anfrage abgeschlossen.");

        // --- Netzwerk ---
        addLogEntry("DEBUG v11: Prüfe Netzwerk-API...");
        if ('connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator) {
            permissionsState.network = true;
            addLogEntry("DEBUG v11: BERECHTIGUNG: Netzwerk-API (`navigator.connection`) gefunden.");
        } else {
            addLogEntry("BERECHTIGUNG: Netzwerk-API wird nicht unterstützt!", 'warn');
        }
        addLogEntry("DEBUG v11: Netzwerk-API-Check abgeschlossen.");

        // --- Bewegung ---
        addLogEntry("DEBUG v11: Prüfe Bewegungssensor...");
        if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG v11: 'requestPermission' Motion-API erkannt, fordere an...");
            try {
                const state = await DeviceMotionEvent.requestPermission();
                permissionsState.motion = (state === 'granted');
                addLogEntry(`DEBUG v11: BERECHTIGUNG: Bewegungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { 
                addLogEntry(`DEBUG v11: BERECHTIGUNG: Bewegungssensor-Fehler bei Anfrage: ${err.message}`, 'error');
                permissionsState.motion = false;
            }
        } else if ('DeviceMotionEvent' in window) {
             permissionsState.motion = true; // Android ohne explizite Anfrage
             addLogEntry("DEBUG v11: BERECHTIGUNG: Bewegungssensor (Android/implizit) OK.");
        } else {
             addLogEntry("BERECHTIGUNG: Bewegungssensor wird nicht unterstützt!", 'error');
             permissionsState.motion = false;
        }
        addLogEntry("DEBUG v11: Bewegungssensor-Check abgeschlossen.");


        // --- Orientierung ---
        addLogEntry("DEBUG v11: Füge kleine Pause ein (500ms)...");
        await delay(500); // Atem-Pause für den Browser
        addLogEntry("DEBUG v11: Prüfe Orientierungssensor...");
        if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
             addLogEntry("DEBUG v11: 'requestPermission' Orientation-API erkannt, fordere an...");
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                permissionsState.orientation = (state === 'granted');
                addLogEntry(`DEBUG v11: BERECHTIGUNG: Orientierungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) {
                 addLogEntry(`DEBUG v11: BERECHTIGUNG: Orientierungssensor-Fehler bei Anfrage: ${err.message}`, 'error');
                 permissionsState.orientation = false;
            }
        } else if ('DeviceOrientationEvent' in window) {
            permissionsState.orientation = true; // Android ohne explizite Anfrage
            addLogEntry("DEBUG v11: BERECHTIGUNG: Orientierungssensor (Android/implizit) OK.");
        } else {
             addLogEntry("BERECHTIGUNG: Orientierungssensor wird nicht unterstützt!", 'error');
             permissionsState.orientation = false;
        }
        addLogEntry("DEBUG v11: Orientierungssensor-Check abgeschlossen.");
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps; // Wir brauchen GPS als Minimum
    }

    // Phase B: Startet alle Logger
    function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. GPS-Logger
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        addLogEntry("DEBUG: 'geolocation.watchPosition' Listener angehängt.");
        
        // 2. Netzwerk-POLLING-Timer
        if (permissionsState.network) {
            networkCheckInterval = setInterval(checkNetworkState, NETWORK_POLL_INTERVAL_MS);
            addLogEntry(`DEBUG: Netzwerk-Polling-Timer gestartet (Intervall: ${NETWORK_POLL_INTERVAL_MS}ms).`);
            checkNetworkState(true); 
        }

        // 3. Bewegungs-Sensor-Logger
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
            addLogEntry("DEBUG: 'devicemotion' Listener angehängt.");
        } else {
             addLogEntry("WARNUNG: Bewegungssensor-Listener NICHT angehängt (Keine Berechtigung oder Unterstützung).", 'warn');
        }
        
        // 4. Orientierungs-Sensor-Logger
        if (permissionsState.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
            addLogEntry("DEBUG: 'deviceorientation' Listener angehängt.");
        } else {
            addLogEntry("WARNUNG: Orientierungssensor-Listener NICHT angehängt (Keine Berechtigung oder Unterstützung).", 'warn');
        }
        
        isLogging = true;
        startBtn.disabled = true;
        permissionBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;
    }

    // ===================================
    // --- BUTTON-HANDLER (v11) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true;
        startBtn.disabled = true; // Sicherstellen, dass Start nicht klickbar ist
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = [];
        flightRecorderBuffer = [];
        logAreaEl.value = "";
        lastNetworkType = ""; 
        // Reset permissions state before requesting
        permissionsState = { gps: false, motion: false, orientation: false, network: false };
        
        const gpsOk = await requestAllPermissions();

        if (gpsOk) {
            statusEl.textContent = "Bereit zum Loggen! (GPS OK)";
            startBtn.disabled = false; // Nur Start freigeben
            downloadBtn.disabled = true;
            permissionBtn.disabled = true; // Bleibt deaktiviert, bis gestoppt wird
        } else {
            statusEl.textContent = "Fehler: GPS-Berechtigung benötigt!";
            permissionBtn.disabled = false; // Erneut versuchen erlauben
        }
    };

    // START
    startBtn.onclick = () => {
        logEntries = [];
        flightRecorderBuffer = [];
        logAreaEl.value = "";
        motionSensorHasFired = false;
        orientationSensorHasFired = false; 
        lastNetworkType = ""; 
        
        addLogEntry(`Logging-Prozess angefordert (v11)...`);
        startAllLoggers();
    };

    // STOP
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
        if (networkCheckInterval) clearInterval(networkCheckInterval); 
        
        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        isLogging = false;
        geoWatchId = null;
        networkCheckInterval = null;
        flightRecorderBuffer = [];
        addLogEntry("Logging gestoppt.");

        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = true; // Start erst nach neuem Pre-Flight
        permissionBtn.disabled = false; // Pre-Flight wieder erlauben
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; 
    };

    // ABSTURZ MARKIEREN
    crashBtn.onclick = () => {
        if (!isLogging) return;
        
        const markerTime = getTimestamp();
        dumpFlightRecorder(markerTime, "ABSTURZ VOM NUTZER MARKIERT");
        
        statusEl.textContent = "ABSTURZ MARKIERT & DUMP ERSTELLT!";
        setTimeout(() => { if(isLogging) statusEl.textContent = "LOGGING..."; }, 3000);
    };

    // DOWNLOAD
    downloadBtn.onclick = () => {
        if (logEntries.length === 0) {
            alert("Keine Logs zum Herunterladen vorhanden.");
            return;
        }
        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain' });
        const filename = `waze_log_v11_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    // Initialen Button-Status setzen
    startBtn.disabled = true;
    stopBtn.disabled = true;
    crashBtn.disabled = true;
    downloadBtn.disabled = true;
});
