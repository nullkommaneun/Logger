/*
 * Waze Korrelations-Logger - System-Debugger v3
 * =============================================
 *
 * NEU in v3:
 * - Checks für Generic Sensor API (window.Sensor, Accelerometer etc.)
 * - Check für Compute Pressure API (window.ComputePressureObserver)
 * - Gibt jetzt detailliertere Infos aus, welche APIs gefunden wurden.
 *
 * Lädt zuerst, prüft Systemvoraussetzungen und fängt globale Fehler.
 */
"use strict";

(function() {
    const debugArea = document.getElementById('debugArea');
    let initTime = Date.now();

    function logDebug(message, level = 'info') {
        const time = new Date();
        const timestamp = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}.${time.getMilliseconds().toString().padStart(3, '0')}`;
        const logString = `[${timestamp}] ${message}`;

        if (debugArea) {
            debugArea.value += logString + '\n';
            debugArea.scrollTop = debugArea.scrollHeight;
        }

        if (level === 'error') console.error(logString);
        else if (level === 'warn') console.warn(logString);
        else console.log(logString);
    }

    logDebug(`Debugger v3 initialisiert...`);

    // --- System-Check ---
    logDebug("--- SYSTEM-CHECK (Herz und Nieren) v3 ---");

    // Sicherstellen, dass wir über HTTPS laufen (wichtig für viele APIs)
    if (window.location.protocol !== "https:") {
        logDebug("SYSTEM-CHECK: HTTPS ... FEHLER! Viele APIs benötigen HTTPS.", 'error');
    } else {
        logDebug("SYSTEM-CHECK: HTTPS ... OK");
    }

    // User Agent
    logDebug(`SYSTEM-CHECK: User Agent ... ${navigator.userAgent}`);

    // Standard APIs
    const checkApi = (name, check) => {
        try {
            if (check()) {
                logDebug(`SYSTEM-CHECK: API '${name}' ... VERFÜGBAR`);
                return true;
            } else {
                logDebug(`SYSTEM-CHECK: API '${name}' ... NICHT VERFÜGBAR`, 'warn');
                return false;
            }
        } catch (e) {
             logDebug(`SYSTEM-CHECK: API '${name}' ... FEHLER BEI PRÜFUNG (${e.message})`, 'error');
             return false;
        }
    };

    checkApi('Geolocation', () => 'geolocation' in navigator);
    checkApi('MediaDevices (Audio/BT)', () => 'mediaDevices' in navigator && 'enumerateDevices' in navigator.mediaDevices);
    checkApi('NetworkInformation (Netzwerk-Typ)', () => 'connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator);

    // Alte Sensor APIs
    const hasOldMotion = checkApi('DeviceMotionEvent (Bewegung - Alt)', () => 'DeviceMotionEvent' in window);
    const hasOldOrientation = checkApi('DeviceOrientationEvent (Ausrichtung - Alt)', () => 'DeviceOrientationEvent' in window);

    // Permission-Checks für alte APIs (iOS/Modern Android)
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
        logDebug("SYSTEM-CHECK: 'requestPermission' Motion-API (Alt) ... GEFUNDEN (Erweiterte Sicherheit)");
    }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        logDebug("SYSTEM-CHECK: 'requestPermission' Orientation-API (Alt) ... GEFUNDEN (Erweiterte Sicherheit)");
    }

    // v12: Generic Sensor API Checks (Experimentell)
    logDebug("--- Experimental API Check ---");
    const hasGenericSensorBase = checkApi('Generic Sensor API (Basis)', () => 'Sensor' in window);
    let foundGenericSensors = [];
    if (hasGenericSensorBase) {
        const sensorsToCheck = ['Accelerometer', 'Gyroscope', 'Magnetometer', 'AmbientLightSensor'];
        sensorsToCheck.forEach(sensorName => {
            if (sensorName in window) {
                 foundGenericSensors.push(sensorName);
            }
        });
        if (foundGenericSensors.length > 0) {
             logDebug(`SYSTEM-CHECK: Generic Sensors gefunden: ${foundGenericSensors.join(', ')}`);
        } else {
             logDebug("SYSTEM-CHECK: Generic Sensor Basis-API da, aber keine spezifischen Sensor-Klassen gefunden.", 'warn');
        }
    }

     // v12: Compute Pressure API Check (Experimentell)
    checkApi('Compute Pressure API', () => 'ComputePressureObserver' in window);

    logDebug("--- SYSTEM-CHECK BEENDET ---");


    // --- Globaler Fehler-Fänger ---
    window.onerror = function(message, source, lineno, colno, error) {
        logDebug("--- !!! GLOBALER FEHLER GEFANGEN !!! ---", 'error');
        logDebug(`FEHLER: ${message}`, 'error');
        logDebug(`QUELLE: ${source}`, 'error');
        logDebug(`ZEILE: ${lineno}, SPALTE: ${colno}`, 'error');
        if (error && error.stack) {
            logDebug(`STACK: ${error.stack}`, 'error');
        }
        logDebug("--- !!! BITTE DIESEN TEXT KOPIEREN !!! ---", 'error');

        // Optional: Verhindern, dass der Standard-Browser-Fehlerhandler ausgelöst wird
        return true;
    };

    window.onunhandledrejection = function(event) {
         logDebug("--- !!! UNBEHANDELTE PROMISE REJECTION GEFANGEN !!! ---", 'error');
         logDebug(`GRUND: ${event.reason}`, 'error');
         if (event.reason && event.reason.stack) {
             logDebug(`STACK: ${event.reason.stack}`, 'error');
         }
         logDebug("--- !!! BITTE DIESEN TEXT KOPIEREN !!! ---", 'error');
    };

})(); // Self-invoking function
