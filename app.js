/*
 * Waze Korrelations-Logger - v2 "Diagnose-Monster"
 * ================================================
 * INKLUSIVE:
 * - GPS (Position, Genauigkeit, Geschwindigkeit)
 * - Netzwerk (Online/Offline)
 * - Bluetooth/Audio (Geräte-Events)
 * - Bewegung (Beschleunigungssensor)
 * - Orientierung (Gyroskop/Kompass)
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

    // --- Logger-Status & Konfiguration ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;

    // --- Sensor-Throttling (WICHTIG!) ---
    // Wir loggen diese Sensoren nicht 60x pro Sekunde, sondern nur alle X Millisekunden
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
        updateDeviceList();
    }

    // 4. Geräteliste auslesen (Versuch)
    async function updateDeviceList() {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
                addLogEntry("BT/AUDIO-FEHLER: MediaDevices API nicht unterstützt.", 'error');
                return;
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(track => track.stop());
            } catch (permErr) {
                addLogEntry("BT/AUDIO-INFO: Mikrofon-Zugriff verweigert, Gerätelabels könnten fehlen.", 'warn');
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

        } catch (err) {
            addLogEntry(`BT/AUDIO-FEHLER: ${err.message}`, 'error');
        }
    }

    // 5. NEU: Bewegungssensor (Beschleunigung)
    function logDeviceMotion(event) {
        const now = Date.now();
        // Throttling: Nur loggen, wenn 2 Sekunden vergangen sind
        if (now - lastMotionLogTime < SENSOR_THROTTLE_MS) {
            return; 
        }
        lastMotionLogTime = now;

        const acc = event.accelerationIncludingGravity;
        if (acc && acc.x !== null) {
            const logData = [
                `SENSOR-MOTION`,
                `X: ${acc.x.toFixed(2)}`,
                `Y: ${acc.y.toFixed(2)}`,
                `Z: ${acc.z.toFixed(2)}`
            ];
            addLogEntry(logData.join(' | '), 'info');
        }
    }

    // 6. NEU: Orientierungssensor (Gyroskop/Kompass)
    function logDeviceOrientation(event) {
        const now = Date.now();
        // Throttling: Nur loggen, wenn 2 Sekunden vergangen sind
        if (now - lastOrientationLogTime < SENSOR_THROTTLE_MS) {
            return;
        }
        lastOrientationLogTime = now;

        if (event.alpha !== null) {
            const logData = [
                `SENSOR-ORIENTATION`,
                `Alpha(Z): ${event.alpha.toFixed(1)}`, // Kompass
                `Beta(X): ${event.beta.toFixed(1)}`,  // Vor/Zurück
                `Gamma(Y): ${event.gamma.toFixed(1)}` // Links/Rechts
            ];
            addLogEntry(logData.join(' | '), 'info');
        }
    }


    // ===================================
    // --- BUTTON-HANDLER ---
    // ===================================

    // START
    // Wir machen die Funktion "async", um auf Berechtigungen (await) warten zu können
    startBtn.onclick = async () => {
        // --- 1. API-Prüfungen ---
        if (!navigator.geolocation) {
            alert("Fehler: Geolocation wird nicht unterstützt.");
            return;
        }
        if (!navigator.mediaDevices) {
            alert("Fehler: MediaDevices (für Bluetooth) wird nicht unterstützt.");
        }

        // --- 2. NEU: iOS Sensor-Berechtigungen (Der "Hack") ---
        // iOS 13+ erfordert eine explizite Nutzer-Aktion, um diese Sensoren zu nutzen
        let motionGranted = false;
        let orientationGranted = false;

        // Versuch für Bewegungssensor
        if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            try {
                const permissionState = await DeviceMotionEvent.requestPermission();
                if (permissionState === 'granted') {
                    motionGranted = true;
                    addLogEntry("SENSOR-INFO: Berechtigung für Bewegung erteilt.");
                } else {
                    addLogEntry("SENSOR-WARN: Berechtigung für Bewegung verweigert.", 'warn');
                }
            } catch (err) { /* Ignorieren, wenn Nutzer ablehnt */ }
        } else {
            // Nicht-iOS-Gerät (Android), Berechtigung ist implizit
            motionGranted = true;
        }

        // Versuch für Orientierungssensor
        if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
            try {
                const permissionState = await DeviceOrientationEvent.requestPermission();
                if (permissionState === 'granted') {
                    orientationGranted = true;
                    addLogEntry("SENSOR-INFO: Berechtigung für Orientierung erteilt.");
                } else {
                    addLogEntry("SENSOR-WARN: Berechtigung für Orientierung verweigert.", 'warn');
                }
            } catch (err) { /* Ignorieren */ }
        } else {
            // Nicht-iOS-Gerät (Android)
            orientationGranted = true;
        }

        // --- 3. Logging-Prozess starten ---
        isLogging = true;
        logEntries = [];
        logAreaEl.value = "";
        addLogEntry("Logging gestartet (v2: Diagnose-Monster)...");

        // UI-Status
        statusEl.textContent = "LOGGING... (Suche GPS)";
        startBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;

        // 4. Alle Logger registrieren
        
        // GPS-Logger
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);

        // BT/Audio-Logger
        if (navigator.mediaDevices) {
            navigator.mediaDevices.ondevicechange = logDeviceChange;
            updateDeviceList();
        }

        // Bewegungs-Sensor-Logger
        if (motionGranted) {
            window.addEventListener('devicemotion', logDeviceMotion);
        }

        // Orientierungs-Sensor-Logger
        if (orientationGranted) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
        }
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

    // ABSTURZ MARKIEREN
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

    // DOWNLOAD
    downloadBtn.onclick = () => {
        if (logEntries.length === 0) {
            alert("Keine Logs zum Herunterladen vorhanden.");
            return;
        }

        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain' });
        const filename = `waze_log_v2_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
});


