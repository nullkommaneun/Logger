/*
 * Waze Korrelations-Logger - v10 "Netzwerk-Spion"
 * ==================================================
 *
 * FEHLERBEHEBUNG (aus Log v9):
 * 1. Das BT/Audio-Polling (v9) war ein FEHLSCHLAG. Der
 * Browser lügt im Hintergrund über die Geräteliste.
 *
 * OPTIMIERUNG (v10):
 * 1. Das BT/Audio-Polling wird ENTFERNT.
 * 2. Es wird durch einen Polling-Timer für die
 * "NetworkInformation" API (`navigator.connection.type`)
 * ersetzt.
 * 3. Wir suchen jetzt nach Änderungen im Netzwerktyp
 * (z.B. von 'cellular' zu 'wifi'), um den
 * Wireless-AA-Handshake zu erkennen.
 *
 * Das ist unser neuer "Rauchender Colt".
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
    let lastNetworkType = ""; // Unser neuer "Speicher"
    const NETWORK_POLL_INTERVAL_MS = 3000; // Alle 3 Sekunden

    // --- v6: DEBUG Heartbeat Flags ---
    let motionSensorHasFired = false;
    let orientationSensorHasFired = false;

    // --- v5: Flugschreiber & Jolt Detection ---
    let flightRecorderBuffer = [];
    const FLIGHT_RECORDER_DURATION_MS = 2500;
    const JOLT_THRESHOLD_MS2 = 25.0; 
    const JOLT_COOLDOWN_MS = 5000; 
    let lastJoltTime = 0;

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
    // --- SENSOR-HANDLER (Überarbeitet v10) ---
    // ===================================

    // 1. GPS-Erfolg
    function logPosition(position) {
        // v10: Wir loggen 'isOnline' nicht mehr hier, da der Netzwerk-Logger das jetzt besser macht.
        const coords = position.coords;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${coords.accuracy.toFixed(1)}m)`;
    }

    // 2. GPS-Fehler
    function logError(error) {
        // (identisch zu v8)
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

    // 3. (GELÖSCHT) Audio-Polling (v9)

    // 4. v10: Intelligente Netzwerk-Polling-Funktion
    function checkNetworkState(isInitialCall = false) {
        if (!permissionsState.network) return; // API nicht verfügbar

        try {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const isOnline = navigator.onLine;
            const currentType = connection ? connection.type : 'unknown'; // z.B. 'cellular', 'wifi'

            const logString = `NETZWERK-STATUS: Online: ${isOnline} | Typ: ${currentType}`;

            // Das ist die "intelligente" v10-Logik:
            // Logge NUR, wenn sich der Typ ändert ODER es der allererste Aufruf ist.
            if (currentType !== lastNetworkType || isInitialCall) {
                if (isInitialCall) {
                    addLogEntry(logString, 'info'); // Nur als Info beim Start
                } else {
                    addLogEntry('NETZWERK-EVENT: Verbindungstyp geändert!', 'warn');
                    addLogEntry(logString, 'warn');
                }
                lastNetworkType = currentType; // Zustand speichern
            }
        } catch (err) {
            addLogEntry(`NETZWERK-FEHLER: ${err.message}`, 'error');
            // Deaktivieren, um Fehler-Spam zu verhindern
            permissionsState.network = false; 
            if (networkCheckInterval) clearInterval(networkCheckInterval);
        }
    }


    // 5. Bewegungssensor
    function logDeviceMotion(event) {
        // (identisch zu v8)
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

    // 6. Orientierungssensor
    function logDeviceOrientation(event) {
        // (identisch zu v8)
        const now = Date.now();
        if (!orientationSensorHasFired) {
            orientationSensorHasFired = true;
            if (event.alpha === null) {
                addLogEntry("DEBUG: 'deviceorientation' feuert, ABER DATEN SIND NULL.", 'warn');
            } else {
                addLogE`[${timestamp}] ${message}`ntry("DEBUG: 'deviceorientation' feuert erfolgreich mit Daten.", 'info');
            }
        }
        if (event.alpha === null) return;
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION', dataString);
    }

    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v10) ---
    // ===================================

    // Phase A: Pre-Flight Check
    async function requestAllPermissions() {
        addLogEntry("Phase A: Fordere Berechtigungen an...");
        statusEl.textContent = "Berechtigungen anfordern...";
        
        // 1. GPS
        try {
            if (!navigator.geolocation) throw new Error("Geolocation wird nicht unterstützt.");
            await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
            });
            permissionsState.gps = true;
            addLogEntry("DEBUG: BERECHTIGUNG: GPS erteilt.");
        } catch (err) {
            addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error');
        }

        // 2. v10: Netzwerk-API-Check
        if ('connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator) {
            permissionsState.network = true;
            addLogEntry("DEBUG: BERECHTIGUNG: Netzwerk-API (`navigator.connection`) gefunden.");
        } else {
            addLogEntry("BERECHTIGUNG: Netzwerk-API wird nicht unterstützt!", 'warn');
        }

        // 3. Bewegung (iOS / Modernes Android)
        if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG: 'requestPermission' Motion-API erkannt, fordere an...");
            try {
                const state = await DeviceMotionEvent.requestPermission();
                permissionsState.motion = (state === 'granted');
                addLogEntry(`DEBUG: BERECHTIGUNG: Bewegungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { 
                addLogEntry(`DEBUG: BERECHTIGUNG: Bewegungssensor-Fehler: ${err.message}`, 'error');
            }
        } else {
            permissionsState.motion = true; // Android
            addLogEntry("DEBUG: BERECHTIGUNG: Bewegungssensor (Android/implizit) OK.");
        }

        // 4. Orientierung (iOS / Modernes Android)
        if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
             addLogEntry("DEBUG: 'requestPermission' Orientation-API erkannt, fordere an...");
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                permissionsState.orientation = (state === 'granted');
                addLogEntry(`DEBUG: BERECHTIGUNG: Orientierungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) {
                 addLogEntry(`DEBUG: BERECHTIGUNG: Orientierungssensor-Fehler: ${err.message}`, 'error');
            }
        } else {
            permissionsState.orientation = true; // Android
            addLogEntry("DEBUG: BERECHTIGUNG: Orientierungssensor (Android/implizit) OK.");
        }
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps;
    }

    // Phase B: Startet alle Logger
    function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. GPS-Logger
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        addLogEntry("DEBUG: 'geolocation.watchPosition' Listener angehängt.");
        
        // 2. v10: Netzwerk-POLLING-Timer
        if (permissionsState.network) {
            networkCheckInterval = setInterval(checkNetworkState, NETWORK_POLL_INTERVAL_MS);
            addLogEntry(`DEBUG: Netzwerk-Polling-Timer gestartet (Intervall: ${NETWORK_POLL_INTERVAL_MS}ms).`);
            checkNetworkState(true); // Logge den initialen Status
        }

        // 3. Bewegungs-Sensor-Logger
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
            addLogEntry("DEBUG: 'devicemotion' Listener angehängt.");
        }
        
        // 4. Orientierungs-Sensor-Logger
        if (permissionsState.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
            addLogEntry("DEBUG: 'deviceorientation' Listener angehängt.");
        }
        
        isLogging = true;
        startBtn.disabled = true;
        permissionBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;
    }

    // ===================================
    // --- BUTTON-HANDLER (v10) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true;
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = [];
        flightRecorderBuffer = [];
        logAreaEl.value = "";
        lastNetworkType = ""; // v10: Status zurücksetzen
        
        const gpsOk = await requestAllPermissions();

        if (gpsOk) {
            statusEl.textContent = "Bereit zum Loggen! (GPS OK)";
            startBtn.disabled = false;
            downloadBtn.disabled = true;
        } else {
            statusEl.textContent = "Fehler: GPS-Berechtigung benötigt!";
            permissionBtn.disabled = false;
        }
    };

    // START
    startBtn.onclick = () => {
        logEntries = [];
        flightRecorderBuffer = [];
        logAreaEl.value = "";
        motionSensorHasFired = false;
        orientationSensorHasFired = false; 
        lastNetworkType = ""; // v10: Status zurücksetzen
        
        addLogEntry(`Logging-Prozess angefordert (v10)...`);
        startAllLoggers();
    };

    // STOP
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        // Alle Listener und Timer stoppen
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
        if (networkCheckInterval) clearInterval(networkCheckInterval); // v10: Polling-Timer stoppen
        
        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        isLogging = false;
        geoWatchId = null;
        networkCheckInterval = null;
        flightRecorderBuffer = [];
        addLogEntry("Logging gestoppt.");

        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = false;
        permissionBtn.disabled = false;
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
        const filename = `waze_log_v10_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
});
