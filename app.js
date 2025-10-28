/*
 * Waze Korrelations-Logger - v3 "Stabiler Start"
 * ================================================
 * NEU: Saubere Trennung von Berechtigungs-Anfrage (Pre-Flight Check)
 * und dem eigentlichen Start der Logger.
 *
 * Gebaut von deinem Sparingpartner.
 */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    
    // --- DOM-Elemente ---
    const statusEl = document.getElementById('status');
    const logAreaEl = document.getElementById('logArea');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const crashBtn = document.getElementById('crashBtn');
    const downloadBtn = document.getElementById('downloadBtn');

    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;

    // --- Sensor-Throttling ---
    const SENSOR_THROTTLE_MS = 2000; // 2 Sekunden
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

    // 1. GPS-Erfolg
    function logPosition(position) {
        const coords = position.coords;
        const isOnline = navigator.onLine;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);

        const logData = [
            `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`,
            `Speed: ${speedKmh} km/h`,
            `Online: ${isOnline}`,
            `Lat: ${coords.latitude.toFixed(5)}`,
            `Lng: ${coords.longitude.toFixed(5)}`
        ];
        
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
        updateDeviceList(false); // 'false' = nicht der erste Aufruf
    }

    // 4. Geräteliste auslesen (Versuch)
    // Wir fügen ein 'isInitialCall' Flag hinzu, um die Mikrofon-Berechtigung
    // nur beim allerersten Mal (Pre-Flight Check) anzufragen.
    async function updateDeviceList(isInitialCall = false) {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
                addLogEntry("BT/AUDIO-FEHLER: MediaDevices API nicht unterstützt.", 'error');
                return false; // Rückgabe 'false' für Misserfolg
            }

            if (isInitialCall) {
                try {
                    // Nur beim ersten Mal die Berechtigung anfragen
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    stream.getTracks().forEach(track => track.stop());
                } catch (permErr) {
                    addLogEntry("BT/AUDIO-INFO: Mikrofon-Zugriff verweigert, Gerätelabels könnten fehlen.", 'warn');
                    return false; // Rückgabe 'false' für Misserfolg
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
            addLogEntry(logString, 'info');
            return true; // Rückgabe 'true' für Erfolg

        } catch (err) {
            addLogEntry(`BT/AUDIO-FEHLER: ${err.message}`, 'error');
            return false; // Rückgabe 'false' für Misserfolg
        }
    }

    // 5. Bewegungssensor (Beschleunigung)
    function logDeviceMotion(event) {
        const now = Date.now();
        if (now - lastMotionLogTime < SENSOR_THROTTLE_MS) return; 
        lastMotionLogTime = now;
        const acc = event.accelerationIncludingGravity;
        if (acc && acc.x !== null) {
            addLogEntry(`SENSOR-MOTION | X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`, 'info');
        }
    }

    // 6. Orientierungssensor (Gyroskop/Kompass)
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
     * NEU: Phase A - Der "Pre-Flight Check"
     * Fragt alle Berechtigungen nacheinander an.
     */
    async function requestAllPermissions() {
        addLogEntry("Phase A: Fordere Berechtigungen an...");
        statusEl.textContent = "Berechtigungen anfordern...";
        
        let permissions = {
            gps: false,
            audio: false,
            motion: false,
            orientation: false
        };

        // 1. GPS-Berechtigung (Trick: getCurrentPosition)
        try {
            if (!navigator.geolocation) {
                throw new Error("Geolocation wird nicht unterstützt.");
            }
            await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
            });
            permissions.gps = true;
            addLogEntry("BERECHTIGUNG: GPS erteilt.");
        } catch (err) {
            addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error');
        }

        // 2. Audio-Berechtigung (für Geräteliste)
        permissions.audio = await updateDeviceList(true); // 'true' = erster Aufruf
        if (permissions.audio) {
            addLogEntry("BERECHTIGUNG: Audio (für Geräteliste) erteilt.");
        }

        // 3. Bewegungssensor (iOS-spezifisch)
        if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            try {
                const state = await DeviceMotionEvent.requestPermission();
                if (state === 'granted') {
                    permissions.motion = true;
                    addLogEntry("BERECHTIGUNG: Bewegungssensor erteilt.");
                } else {
                    addLogEntry("BERECHTIGUNG: Bewegungssensor verweigert.", 'warn');
                }
            } catch (err) { /* Ignorieren */ }
        } else {
            permissions.motion = true; // Android / Implizit
        }

        // 4. Orientierungssensor (iOS-spezifisch)
        if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                if (state === 'granted') {
                    permissions.orientation = true;
                    addLogEntry("BERECHTIGUNG: Orientierungssensor erteilt.");
                } else {
                    addLogEntry("BERECHTIGUNG: Orientierungssensor verweigert.", 'warn');
                }
            } catch (err) { /* Ignorieren */ }
        } else {
            permissions.orientation = true; // Android / Implizit
        }
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissions;
    }

    /**
     * NEU: Phase B - Startet alle Logger, für die wir Berechtigungen haben.
     */
    function startAllLoggers(permissions) {
        addLogEntry("Phase B: Starte alle Logger...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. GPS-Logger
        if (permissions.gps) {
            const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
            geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        } else {
            addLogEntry("GPS-Logger nicht gestartet (Keine Berechtigung).", 'error');
        }

        // 2. BT/Audio-Logger
        if (permissions.audio && navigator.mediaDevices) {
            navigator.mediaDevices.ondevicechange = logDeviceChange;
        }

        // 3. Bewegungs-Sensor-Logger
        if (permissions.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
        }

        // 4. Orientierungs-Sensor-Logger
        if (permissions.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
        }
        
        isLogging = true;
        // UI-Status aktualisieren
        startBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;
    }

    // ===================================
    // --- BUTTON-HANDLER (Überarbeitet) ---
    // ===================================

    // START
    startBtn.onclick = async () => {
        // UI für den Start-Prozess
        startBtn.disabled = true;
        statusEl.textContent = "Starte...";
        logEntries = [];
        logAreaEl.value = "";
        addLogEntry("Logging-Prozess angefordert (v3)...");

        // Führe Phase A aus
        const permissions = await requestAllPermissions();

        // Prüfen, ob wir überhaupt weitermachen können
        if (!permissions.gps) {
            addLogEntry("Kritischer Fehler: GPS-Berechtigung nicht erteilt. Logging nicht gestartet.", 'error');
            statusEl.textContent = "Fehler: GPS benötigt!";
            startBtn.disabled = false; // Start-Button wieder freigeben
            return;
        }

        // Führe Phase B aus
        startAllLoggers(permissions);
    };

    // STOP
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        // 1. Alle Logger stoppen
        if (geoWatchId) {
            navigator.geolocation.clearWatch(geoWatchId);
            geoWatchId = null;
        }
        if (navigator.mediaDevices) {
            navigator.mediaDevices.ondevicechange = null;
        }
        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        isLogging = false;
        addLogEntry("Logging gestoppt.");

        // UI-Status
        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = false;
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; 
    };

    // ABSTURZ MARKIEREN (unverändert)
    crashBtn.onclick = () => {
        if (!isLogging) return;
        addLogEntry("\n--- !!! ABSTURZ VOM NUTZER MARKIERT !!! ---\n", 'warn');
        
        statusEl.textContent = "ABSTURZ MARKIERT!";
        setTimeout(() => {
            if(isLogging) {
                statusEl.textContent = "LOGGING...";
            }
        }, 2000);
    };

    // DOWNLOAD (unverändert)
    downloadBtn.onclick = () => {
        if (logEntries.length === 0) {
            alert("Keine Logs zum Herunterladen vorhanden.");
            return;
        }

        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain' });
        const filename = `waze_log_v3_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
});
