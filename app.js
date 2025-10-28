/*
 * Waze Korrelations-Logger - v4 "Saubere Trennung"
 * ================================================
 * NEU: Eigener Button (permissionBtn) nur für Berechtigungen (Phase A).
 * Der Start-Button (startBtn) ist anfangs deaktiviert und
 * startet nur noch die Logger (Phase B).
 *
 * Das ist die von dir gewünschte "Zweistufige Rakete".
 *
 * Gebaut von deinem Sparingpartner.
 */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    
    // --- DOM-Elemente ---
    const statusEl = document.getElementById('status');
    const logAreaEl = document.getElementById('logArea');
    const permissionBtn = document.getElementById('permissionBtn'); // NEU
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const crashBtn = document.getElementById('crashBtn');
    const downloadBtn = document.getElementById('downloadBtn');

    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;
    // NEU: Wir speichern den Status der Berechtigungen
    let permissionsState = {
        gps: false,
        audio: false,
        motion: false,
        orientation: false
    };

    // --- Sensor-Throttling ---
    const SENSOR_THROTTLE_MS = 2000;
    let lastMotionLogTime = 0;
    let lastOrientationLogTime = 0;


    // --- Universal-Funktion zum Loggen ---
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

    // ===================================
    // --- SENSOR-HANDLER (Das Herzstück) ---
    // (Diese Funktionen bleiben unverändert)
    // ===================================

    function logPosition(position) {
        const coords = position.coords;
        const isOnline = navigator.onLine;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h`, `Online: ${isOnline}` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${coords.accuracy.toFixed(1)}m)`;
    }

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

    function logDeviceChange() {
        addLogEntry('BT/AUDIO-EVENT: Geräte-Änderung erkannt!', 'warn');
        updateDeviceList(false); // 'false' = nicht der erste Aufruf
    }

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
            if (!isInitialCall) addLogEntry(logString, 'info'); // Nur loggen bei echten Events, nicht beim Check
            return true;
        } catch (err) {
            addLogEntry(`BT/AUDIO-FEHLER: ${err.message}`, 'error');
            return false;
        }
    }

    function logDeviceMotion(event) {
        const now = Date.now();
        if (now - lastMotionLogTime < SENSOR_THROTTLE_MS) return; 
        lastMotionLogTime = now;
        const acc = event.accelerationIncludingGravity;
        if (acc && acc.x !== null) {
            addLogEntry(`SENSOR-MOTION | X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`, 'info');
        }
    }

    function logDeviceOrientation(event) {
        const now = Date.now();
        if (now - lastOrientationLogTime < SENSOR_THROTTLE_MS) return;
        lastOrientationLogTime = now;
        if (event.alpha !== null) {
            addLogEntry(`SENSOR-ORIENTATION | Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`, 'info');
        }
    }

    // ===================================
    // --- NEUE STEUERUNGS-FUNKTIONEN ---
    // ===================================

    /**
     * Phase A - Der "Pre-Flight Check"
     * Wird NUR von permissionBtn ausgelöst.
     */
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
        return permissionsState.gps; // Nur zurückgeben, ob das *kritische* (GPS) OK ist
    }

    /**
     * Phase B - Startet alle Logger.
     * Wird NUR von startBtn ausgelöst.
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

        // 3. Bewegungs-Sensor-Logger
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
        }

        // 4. Orientierungs-Sensor-Logger
        if (permissionsState.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
        }
        
        isLogging = true;
        // UI-Status aktualisieren
        startBtn.disabled = true;
        permissionBtn.disabled = true; // Kann man während des Loggens nicht ändern
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;
    }

    // ===================================
    // --- BUTTON-HANDLER (Überarbeitet v4) ---
    // ===================================

    // NEUER BUTTON: PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true;
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = [];
        logAreaEl.value = "";
        
        const gpsOk = await requestAllPermissions();

        if (gpsOk) {
            statusEl.textContent = "Bereit zum Loggen! (GPS OK)";
            startBtn.disabled = false; // RAKETENSTUFE 2 FREISCHALTEN!
            downloadBtn.disabled = true; // Reset
        } else {
            statusEl.textContent = "Fehler: GPS-Berechtigung benötigt!";
            permissionBtn.disabled = false; // Erneut versuchen lassen
        }
    };

    // START (startet jetzt nur noch Phase B)
    startBtn.onclick = () => {
        // Leere Logs für den neuen Lauf
        logEntries = [];
        logAreaEl.value = "";
        addLogEntry("Logging-Prozess angefordert (v4)...");
        
        // Führe Phase B aus
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
        addLogEntry("Logging gestoppt.");

        // UI-Status
        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = false; // Bereit für nächsten Lauf
        permissionBtn.disabled = true; // Berechtigungen bleiben erteilt
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; 
    };

    // ABSTURZ MARKIEREN (unverändert)
    crashBtn.onclick = () => {
        if (!isLogging) return;
        addLogEntry("\n--- !!! ABSTURZ VOM NUTZER MARKIERT !!! ---\n", 'warn');
        statusEl.textContent = "ABSTURZ MARKIERT!";
        setTimeout(() => { if(isLogging) statusEl.textContent = "LOGGING..."; }, 2000);
    };

    // DOWNLOAD (unverändert)
    downloadBtn.onclick = () => {
        if (logEntries.length === 0) {
            alert("Keine Logs zum Herunterladen vorhanden.");
            return;
        }
        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain' });
        const filename = `waze_log_v4_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
});


 
