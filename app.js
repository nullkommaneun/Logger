/*
 * Waze Korrelations-Logger - v7 (KORRIGIERT)
 * ================================================
 *
 * FEHLERBEHEBUNG:
 * 1. Der versehentlich einkopierte "Plugin-Ausführung..."-Fehler
 * aus v6 wurde in `startAllLoggers` entfernt.
 *
 * Alle anderen Funktionen (v5/v6 Meta-Logging) sind intakt.
 * Dieser Code sollte jetzt vom neuen `debugger.js` überwacht werden.
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
    let permissionsState = { gps: false, audio: false, motion: false, orientation: false };

    // --- v6: DEBUG Heartbeat Flags ---
    let motionSensorHasFired = false;
    let orientationSensorHasFired = false;

    // --- v5: Flugschreiber & Jolt Detection ---
    let flightRecorderBuffer = [];
    const FLIGHT_RECORDER_DURATION_MS = 2500;
    const JOLT_THRESHOLD_MS2 = 25.0;
    const JOLT_COOLDOWN_MS = 3000;
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

    // ===================================
    // --- SENSOR-HANDLER (Überarbeitet v6) ---
    // ===================================

    // 1. GPS-Erfolg
    function logPosition(position) {
        const coords = position.coords;
        const isOnline = navigator.onLine;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h`, `Online: ${isOnline}` ];
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

    // 3. Audio/Bluetooth-Geräte-Änderung
    function logDeviceChange() {
        addLogEntry('BT/AUDIO-EVENT: Geräte-Änderung erkannt!', 'warn');
        updateDeviceList(false);
    }

    // 4. Geräteliste auslesen
    async function updateDeviceList(isInitialCall = false) {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
                addLogEntry("BT/AUDIO-FEHLER: MediaDevices API nicht unterstützt.", 'error');
                return false;
            }
            if (isInitialCall) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    stream.getTracks().forEach(track => track.stop());
                } catch (permErr) {
                    addLogEntry("BT/AUDIO-INFO: Mikrofon-Zugriff verweigert, Gerätelabels könnten fehlen.", 'warn');
                    return false;
                }
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            let audioOutputs = [];
            devices.forEach(device => {
                if (device.kind === 'audiooutput') {
                    audioOutputs.push(device.label || 'Unbenanntes Gerät');
                }
            });
            const logString = `BT/AUDIO-STATUS: ${audioOutputs.length} Audio-Ausgänge | Namen: [${audioOutputs.join(', ')}]`;
            if (isInitialCall) {
                addLogEntry("DEBUG: Audio-Check (initial) erfolgreich.", 'info');
            } else {
                addLogEntry(logString, 'info');
            }
            return true;
        } catch (err) {
            addLogEntry(`BT/AUDIO-FEHLER: ${err.message}`, 'error');
            return false;
        }
    }

    // 5. Bewegungssensor
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
            addLogEntry(`--- !!! HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)}) !!! ---`, 'warn');
        }
    }

    // 6. Orientierungssensor
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
    // --- STEUERUNGS-FUNKTIONEN (v7) ---
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

        // 2. Audio
        permissionsState.audio = await updateDeviceList(true);
        if (permissionsState.audio) {
            addLogEntry("DEBUG: BERECHTIGUNG: Audio (für Geräteliste) erteilt.");
        }

        // 3. Bewegung (iOS)
        if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG: iOS-Gerät erkannt, fordere 'DeviceMotionEvent'-Berechtigung an...");
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

        // 4. Orientierung (iOS)
        if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG: iOS-Gerät erkannt, fordere 'DeviceOrientationEvent'-Berechtigung an...");
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
        
        // 2. BT/Audio-Logger
        if (permissionsState.audio && navigator.mediaDevices) {
            navigator.mediaDevices.ondevicechange = logDeviceChange;
            addLogEntry("DEBUG: 'mediaDevices.ondevicechange' Listener angehängt.");
            updateDeviceList(false);
        }

        // 3. Bewegungs-Sensor-Logger
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
            addLogEntry("DEBUG: 'devicemotion' Listener angehängt.");
        }
        
        // --- HIER WAR DER FEHLER IN v6 ---
        // Die fehlerhafte "Plugin..."-Zeile wurde entfernt.
        
        // 4. Orientierungs-Sensor-Logger
        if (permissionsState.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
            addLogEntry("DEBUG: 'deviceorientation' Listener angehängt.");
        }
        
        isLogging = true;
        // UI-Status aktualisieren
        startBtn.disabled = true;
        permissionBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;
    }

    // ===================================
    // --- BUTTON-HANDLER (v7) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true;
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = [];
        flightRecorderBuffer = [];
        logAreaEl.value = "";
        
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
        
        addLogEntry("Logging-Prozess angefordert (v7)...");
        startAllLoggers();
    };

    // STOP
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
        if (navigator.mediaDevices) navigator.mediaDevices.ondevicechange = null;
        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        isLogging = false;
        geoWatchId = null;
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
        addLogEntry(`\n--- !!! ABSTURZ VOM NUTZER MARKIERT (${markerTime}) !!! ---`, 'warn');
        
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
        const filename = `waze_log_v7_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
});


