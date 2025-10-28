/*
 * Waze Korrelations-Logger - v5 "Flugschreiber"
 * ================================================
 * NEU:
 * 1. "Flugschreiber" (Ring Puffer): Die Sensoren MOTION und ORIENTATION
 * loggen jetzt UN-GEDROSSELT in einen 2.5s-Puffer.
 * 2. "Absturz"-Button: Dumpt den gesamten Puffer-Inhalt ins Haupt-Log.
 * 3. CLEVERE FUNKTION: "Jolt Detection" (Stoßerkennung). Loggt automatisch
 * harte Schläge (z.B. Schlaglöcher) ins Haupt-Log.
 *
 * Das ist unsere "Blackbox".
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
    let logEntries = []; // Das "saubere" Haupt-Log
    let geoWatchId = null;
    let permissionsState = { gps: false, audio: false, motion: false, orientation: false };

    // --- v5: FLUGSCHREIBER (Ring Puffer) ---
    let flightRecorderBuffer = []; // Separater Puffer für laute Sensoren
    const FLIGHT_RECORDER_DURATION_MS = 2500; // Speichert 2.5 Sekunden

    // --- v5: "IMPRESS ME" FUNKTION (Jolt Detection) ---
    const JOLT_THRESHOLD_MS2 = 25.0; // m/s^2 (Normale Schwerkraft ist 9.8. 25 ist ein harter Stoß)
    const JOLT_COOLDOWN_MS = 3000; // 3 Sek. Cooldown nach einem Stoß
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

    // --- v5: NEUE Funktion für den Flugschreiber-Puffer ---
    function pushToFlightRecorder(timestamp, type, dataString) {
        // 1. Neuen Eintrag hinzufügen
        flightRecorderBuffer.push({ timestamp, type, dataString });

        // 2. Alte Einträge "rauswerfen" (Ring-Puffer-Logik)
        const cutoffTime = timestamp - FLIGHT_RECORDER_DURATION_MS;
        // .shift() entfernt das erste (älteste) Element
        while (flightRecorderBuffer.length > 0 && flightRecorderBuffer[0].timestamp < cutoffTime) {
            flightRecorderBuffer.shift();
        }
    }

    // ===================================
    // --- SENSOR-HANDLER (Überarbeitet v5) ---
    // ===================================

    // 1. GPS-Erfolg (Loggt weiter ins Haupt-Log)
    function logPosition(position) {
        const coords = position.coords;
        const isOnline = navigator.onLine;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h`, `Online: ${isOnline}` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${coords.accuracy.toFixed(1)}m)`;
    }

    // 2. GPS-Fehler (Loggt weiter ins Haupt-Log)
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

    // 3. Audio/Bluetooth-Geräte-Änderung (Loggt weiter ins Haupt-Log)
    function logDeviceChange() {
        addLogEntry('BT/AUDIO-EVENT: Geräte-Änderung erkannt!', 'warn');
        updateDeviceList(false); // 'false' = nicht der erste Aufruf
    }

    // 4. Geräteliste auslesen (Loggt weiter ins Haupt-Log)
    async function updateDeviceList(isInitialCall = false) {
        try {
            // ... (Funktion ist identisch zu v4)
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
            if (!isInitialCall) addLogEntry(logString, 'info');
            return true;
        } catch (err) {
            addLogEntry(`BT/AUDIO-FEHLER: ${err.message}`, 'error');
            return false;
        }
    }

    // 5. Bewegungssensor (Loggt jetzt in den FLUGSCHREIBER)
    function logDeviceMotion(event) {
        const now = Date.now();
        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null) return;

        // 5a. Daten für den Flugschreiber (un-gedrosselt)
        const dataString = `X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'MOTION', dataString);

        // 5b. CLEVERE FUNKTION: Jolt Detection (loggt ins Haupt-Log)
        const gForce = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            addLogEntry(`--- !!! HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)}) !!! ---`, 'warn');
        }
    }

    // 6. Orientierungssensor (Loggt jetzt in den FLUGSCHREIBER)
    function logDeviceOrientation(event) {
        const now = Date.now();
        if (event.alpha === null) return;

        // 6a. Daten für den Flugschreiber (un-gedrosselt)
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION', dataString);
    }


    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v4) ---
    // (Diese bleiben fast identisch)
    // ===================================

    /**
     * Phase A - Der "Pre-Flight Check"
     */
    async function requestAllPermissions() {
        // ... (Funktion ist identisch zu v4)
        addLogEntry("Phase A: Fordere Berechtigungen an...");
        statusEl.textContent = "Berechtigungen anfordern...";
        
        // 1. GPS
        try {
            if (!navigator.geolocation) throw new Error("Geolocation wird nicht unterstützt.");
            await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
            });
            permissionsState.gps = true;
            addLogEntry("BERECHTIGUNG: GPS erteilt.");
        } catch (err) {
            addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error');
        }

        // 2. Audio
        permissionsState.audio = await updateDeviceList(true); // 'true' = erster Aufruf
        if (permissionsState.audio) {
            addLogEntry("BERECHTIGUNG: Audio (für Geräteliste) erteilt.");
        }

        // 3. Bewegung (iOS)
        if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            try {
                const state = await DeviceMotionEvent.requestPermission();
                permissionsState.motion = (state === 'granted');
            } catch (err) { /* Ignorieren */ }
        } else {
            permissionsState.motion = true; // Android
        }
        if(permissionsState.motion) addLogEntry("BERECHTIGUNG: Bewegungssensor OK.");

        // 4. Orientierung (iOS)
        if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                permissionsState.orientation = (state === 'granted');
            } catch (err) { /* Ignorieren */ }
        } else {
            permissionsState.orientation = true; // Android
        }
        if(permissionsState.orientation) addLogEntry("BERECHTIGUNG: Orientierungssensor OK.");
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps;
    }

    /**
     * Phase B - Startet alle Logger.
     */
    function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. GPS-Logger (Muss vorhanden sein)
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        
        // 2. BT/Audio-Logger
        if (permissionsState.audio && navigator.mediaDevices) {
            navigator.mediaDevices.ondevicechange = logDeviceChange;
            updateDeviceList(false); // Logge den aktuellen Status beim Start
        }

        // 3. Bewegungs-Sensor-Logger (UN-GEDROSSELT)
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
        }

        // 4. Orientierungs-Sensor-Logger (UN-GEDROSSELT)
        if (permissionsState.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
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
    // --- BUTTON-HANDLER (Überarbeitet v5) ---
    // ===================================

    // PRE-FLIGHT CHECK (identisch zu v4)
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true;
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = [];
        flightRecorderBuffer = []; // Puffer leeren
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

    // START (identisch zu v4)
    startBtn.onclick = () => {
        logEntries = [];
        flightRecorderBuffer = []; // Puffer leeren
        logAreaEl.value = "";
        addLogEntry("Logging-Prozess angefordert (v5)...");
        startAllLoggers();
    };

    // STOP (identisch zu v4, plus Puffer leeren)
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
        if (navigator.mediaDevices) navigator.mediaDevices.ondevicechange = null;
        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        isLogging = false;
        geoWatchId = null;
        flightRecorderBuffer = []; // Puffer leeren
        addLogEntry("Logging gestoppt.");

        // UI-Status
        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = false;
        permissionBtn.disabled = false; // Wieder freigeben
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; 
    };

    // ABSTURZ MARKIEREN (NEUE FUNKTION v5)
    crashBtn.onclick = () => {
        if (!isLogging) return;
        
        const markerTime = getTimestamp();
        addLogEntry(`\n--- !!! ABSTURZ VOM NUTZER MARKIERT (${markerTime}) !!! ---`, 'warn');
        
        // --- FLUGSCHREIBER-DUMP ---
        addLogEntry(`--- START FLUGSCHREIBER-DUMP (Letzte ${FLIGHT_RECORDER_DURATION_MS}ms) ---`, 'warn');
        
        if (flightRecorderBuffer.length === 0) {
            addLogEntry(" (Flugschreiber-Puffer ist leer) ", 'warn');
        } else {
            // Gehe durch eine KOPIE des Puffers, falls er sich währenddessen ändert
            [...flightRecorderBuffer].forEach(entry => {
                const timeDiff = new Date(markerTime).getTime() - entry.timestamp;
                const timeAgo = (timeDiff / 1000).toFixed(3); // z.B. "1.234s zuvor"
                addLogEntry(`[T-${timeAgo}s] | ${entry.type} | ${entry.dataString}`, 'info');
            });
        }
        addLogEntry("--- ENDE FLUGSCHREIBER-DUMP ---\n", 'warn');
        // --- ENDE DUMP ---
        
        statusEl.textContent = "ABSTURZ MARKIERT & DUMP ERSTELLT!";
        setTimeout(() => { if(isLogging) statusEl.textContent = "LOGGING..."; }, 3000);
    };

    // DOWNLOAD (identisch zu v4)
    downloadBtn.onclick = () => {
        if (logEntries.length === 0) {
            alert("Keine Logs zum Herunterladen vorhanden.");
            return;
        }
        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain' });
        const filename = `waze_log_v5_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
}); 
