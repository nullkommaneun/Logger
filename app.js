/*
 * Waze Korrelations-Logger - v12 "Experimental Sensors"
 * =======================================================
 *
 * NEU in v12:
 * - Integration der experimentellen Generic Sensor API
 * (Accelerometer, Gyroscope, AmbientLightSensor).
 * - Integration der experimentellen Compute Pressure API.
 * - App prüft beim Start, welche APIs verfügbar sind
 * (abhängig von Browser & aktivierten Flags).
 * - Nutzt die neuen APIs, wenn verfügbar, sonst Fallback
 * auf die alten 'devicemotion'/'deviceorientation'.
 * - Fügt Umgebungslicht und CPU-Last zum Logging hinzu.
 * - Flugschreiber loggt jetzt die jeweils aktiven Sensoren.
 * - `debugger.js` (v3) prüft die API-Verfügbarkeit.
 * - `index.html` (v12) enthält Warnhinweis zu Flags.
 *
 * Das ist "Basteln" an der vordersten Front!
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

    // --- Logger-Status & Konfiguration ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;
    let permissionsState = {
        gps: false, network: false,
        motionOld: false, orientationOld: false, // Fallback Sensoren
        accelNew: false, gyroNew: false, lightNew: false, // Generic Sensors
        cpu: false // Compute Pressure
    };
    let activeSensorMode = 'old'; // 'old' oder 'new'

    // v10: Netzwerk-Polling
    let networkCheckInterval = null;
    let lastNetworkType = "";
    const NETWORK_POLL_INTERVAL_MS = 3000;

    // v12: Compute Pressure Observer
    let pressureObserver = null;
    let lastCpuState = 'nominal';

    // v12: Generic Sensor Instanzen
    let accelerometer = null;
    let gyroscope = null;
    let ambientLightSensor = null;
    const SENSOR_FREQUENCY = 10; // Hz (z.B. 10 Mal pro Sekunde)

    // v6: DEBUG Heartbeat Flags
    let motionSensorHasFired = false;
    let orientationSensorHasFired = false;

    // v5: Flugschreiber & Jolt Detection
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
        if (logAreaEl) { // Sicherstellen, dass das Element existiert
            logAreaEl.value = logEntries.slice(-100).join('\n');
            logAreaEl.scrollTop = logAreaEl.scrollHeight;
        }
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
    // --- SENSOR-HANDLER (v12) ---
    // ===================================

    // --- Standard Sensoren ---
    function logPosition(position) { /* (identisch zu v11) */
        const coords = position.coords;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${coords.accuracy.toFixed(1)}m)`;
     }
    function logError(error) { /* (identisch zu v11) */
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
    function checkNetworkState(isInitialCall = false) { /* (identisch zu v11) */
        if (!permissionsState.network) return;
        try {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const isOnline = navigator.onLine;
            const currentType = connection ? connection.type : 'unknown';
            const logString = `NETZWERK-STATUS: Online: ${isOnline} | Typ: ${currentType}`;
            if (currentType !== lastNetworkType || isInitialCall) {
                if (isInitialCall) { addLogEntry(logString, 'info'); }
                else {
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

    // --- Alte Motion/Orientation (Nur als Fallback) ---
    function logDeviceMotionFallback(event) {
        // (Logik wie in v11, aber jetzt nur als Fallback)
        const now = Date.now();
        const acc = event.accelerationIncludingGravity;

        if (!motionSensorHasFired) {
            motionSensorHasFired = true;
            if (!acc || acc.x === null) { addLogEntry("DEBUG (Fallback): 'devicemotion' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG (Fallback): 'devicemotion' feuert erfolgreich mit Daten.", 'info');}
        }
        if (!acc || acc.x === null) return;

        const dataString = `X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'MOTION (Old)', dataString); // Markieren als "Old"

        const gForce = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            const reason = `HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)})`;
            dumpFlightRecorder(getTimestamp(), reason);
        }
    }
    function logDeviceOrientationFallback(event) {
        // (Logik wie in v11, aber jetzt nur als Fallback)
         const now = Date.now();
        if (!orientationSensorHasFired) {
            orientationSensorHasFired = true;
            if (event.alpha === null) { addLogEntry("DEBUG (Fallback): 'deviceorientation' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG (Fallback): 'deviceorientation' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (event.alpha === null) return;
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION (Old)', dataString); // Markieren als "Old"
    }

    // --- v12: Neue Generic Sensor API Handler ---
    function handleNewAccelerometerReading() {
        const now = Date.now();
        if (!accelerometer || accelerometer.x === null) return;

         if (!motionSensorHasFired) { // Nutzen gleiches Flag wie alter Sensor
            motionSensorHasFired = true;
            addLogEntry("DEBUG (New API): 'Accelerometer' feuert erfolgreich mit Daten.", 'info');
        }

        const dataString = `X: ${accelerometer.x.toFixed(2)} | Y: ${accelerometer.y.toFixed(2)} | Z: ${accelerometer.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'ACCEL (New)', dataString); // Markieren als "New"

        // Jolt Detection mit neuen Daten
        const gForce = Math.sqrt(accelerometer.x**2 + accelerometer.y**2 + accelerometer.z**2);
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            const reason = `HARTER STOSS ERKANNT (New API G-Force: ${gForce.toFixed(1)})`;
            dumpFlightRecorder(getTimestamp(), reason);
        }
    }

    function handleNewGyroscopeReading() {
        const now = Date.now();
         if (!gyroscope || gyroscope.x === null) return;

         if (!orientationSensorHasFired) { // Nutzen gleiches Flag wie alter Sensor
             orientationSensorHasFired = true;
             addLogEntry("DEBUG (New API): 'Gyroscope' feuert erfolgreich mit Daten.", 'info');
         }

        const dataString = `X: ${gyroscope.x.toFixed(2)} | Y: ${gyroscope.y.toFixed(2)} | Z: ${gyroscope.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'GYRO (New)', dataString); // Markieren als "New"
    }

    function handleAmbientLightReading() {
         if (!ambientLightSensor || ambientLightSensor.illuminance === null) return;
         // Nur alle paar Sekunden loggen, da es sich nicht ständig ändert
         const now = Date.now();
         if (now - (handleAmbientLightReading.lastLogTime || 0) > 5000) { // Alle 5 Sek
            addLogEntry(`SENSOR-LIGHT: ${ambientLightSensor.illuminance.toFixed(0)} lux`);
            handleAmbientLightReading.lastLogTime = now;
         }
    }

    function handleGenericSensorError(event, sensorName) {
         addLogEntry(`SENSOR-FEHLER (${sensorName}): ${event.error.name} - ${event.error.message}`, 'error');
         // Versuchen, den Sensor neu zu starten? Fürs Erste nur loggen.
    }

     // --- v12: Compute Pressure Handler ---
     function handleComputePressureUpdate(update) {
         const newState = update.state;
         if (newState !== lastCpuState) {
             addLogEntry(`SYSTEM-CPU: Druck geändert zu '${newState}'`, 'warn');
             lastCpuState = newState;
         }
     }


    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v12) ---
    // ===================================

    // Phase A: Pre-Flight Check (Mit Stethoskop und Feature Detection)
    async function requestAllPermissions() {
        addLogEntry("Phase A: Fordere Berechtigungen an (v12)...");
        statusEl.textContent = "Berechtigungen anfordern...";
        permissionsState = { gps: false, network: false, motionOld: false, orientationOld: false, accelNew: false, gyroNew: false, lightNew: false, cpu: false }; // Reset

        // --- GPS (Wie v11) ---
        addLogEntry("DEBUG v12: Fordere GPS an...");
        try {
            if (!navigator.geolocation) throw new Error("Geolocation nicht unterstützt.");
            await new Promise((resolve, reject) => { navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }); });
            permissionsState.gps = true;
            addLogEntry("DEBUG v12: BERECHTIGUNG: GPS erteilt.");
        } catch (err) { addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error'); permissionsState.gps = false;}
        addLogEntry("DEBUG v12: GPS-Anfrage abgeschlossen.");

        // --- Netzwerk (Wie v11) ---
        addLogEntry("DEBUG v12: Prüfe Netzwerk-API...");
        if ('connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator) {
            permissionsState.network = true;
            addLogEntry("DEBUG v12: BERECHTIGUNG: Netzwerk-API (`navigator.connection`) gefunden.");
        } else { addLogEntry("BERECHTIGUNG: Netzwerk-API wird nicht unterstützt!", 'warn'); }
        addLogEntry("DEBUG v12: Netzwerk-API-Check abgeschlossen.");

        // --- NEU v12: Generic Sensor API ---
        let useNewSensors = false;
        if ('Accelerometer' in window && 'Gyroscope' in window) { // Prüfen, ob die Basis-Sensoren da sind
             addLogEntry("DEBUG v12: Generic Sensor API (Accelerometer, Gyroscope) gefunden.");
             try {
                // Berechtigungen für Generic Sensors anfordern (geht oft über einen einzigen Dialog)
                 const accelPerm = await navigator.permissions.query({ name: 'accelerometer' });
                 const gyroPerm = await navigator.permissions.query({ name: 'gyroscope' });
                 
                 // v12.1 Bugfix: State check hinzugefügt
                 if (accelPerm.state === 'granted' && gyroPerm.state === 'granted') {
                     permissionsState.accelNew = true;
                     permissionsState.gyroNew = true;
                     useNewSensors = true; // Wir können die neuen Sensoren nutzen!
                     addLogEntry("DEBUG v12: BERECHTIGUNG: Generic Sensors (Accel, Gyro) - Bereits erteilt.");

                    // Versuchen, auch Lichtsensor zu bekommen (optional)
                     if ('AmbientLightSensor' in window) {
                         try {
                             const lightPerm = await navigator.permissions.query({ name: 'ambient-light-sensor' });
                              if (lightPerm.state === 'granted') {
                                permissionsState.lightNew = true;
                                addLogEntry("DEBUG v12: BERECHTIGUNG: AmbientLightSensor - Bereits erteilt.");
                              } else {
                                addLogEntry("DEBUG v12: BERECHTIGUNG: AmbientLightSensor - Status: " + lightPerm.state, 'warn');
                              }
                         } catch (lightErr) {
                              addLogEntry(`BERECHTIGUNG: AmbientLightSensor - Fehler bei Anfrage: ${lightErr.message}`, 'warn');
                         }
                     } else {
                         addLogEntry("DEBUG v12: AmbientLightSensor API nicht gefunden.");
                     }

                 } else {
                     addLogEntry("DEBUG v12: BERECHTIGUNG: Generic Sensors (Accel, Gyro) - Status: " + accelPerm.state + ", " + gyroPerm.state, 'warn');
                     // Hier könnte man den Nutzer auffordern, die Berechtigung manuell zu erteilen
                 }

             } catch (sensorPermErr) {
                 addLogEntry(`BERECHTIGUNG: Generic Sensors - Fehler bei Permissions-API: ${sensorPermErr.message}`, 'error');
             }
        } else {
            addLogEntry("DEBUG v12: Generic Sensor API (Accel/Gyro) nicht gefunden. Nutze Fallback.");
        }

        // --- Fallback: Alte Motion/Orientation (Nur wenn neue nicht gehen) ---
        if (!useNewSensors) {
            activeSensorMode = 'old';
            addLogEntry("DEBUG v12: Aktiviere Fallback-Sensoren (Motion/Orientation)...");
             // Bewegung (Alt)
            addLogEntry("DEBUG v12: Prüfe alten Bewegungssensor...");
             if (typeof(DeviceMotionEvent.requestPermission) === 'function') { /* (wie v11) */
                 addLogEntry("DEBUG v12: 'requestPermission' Motion-API (Alt) erkannt, fordere an...");
                 try {
                     const state = await DeviceMotionEvent.requestPermission();
                     permissionsState.motionOld = (state === 'granted');
                     addLogEntry(`DEBUG v12: BERECHTIGUNG (Fallback): Bewegungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
                 } catch (err) { addLogEntry(`DEBUG v12: BERECHTIGUNG (Fallback): Bewegungssensor-Fehler: ${err.message}`, 'error');}
             } else if ('DeviceMotionEvent' in window) { permissionsState.motionOld = true; addLogEntry("DEBUG v12: BERECHTIGUNG (Fallback): Bewegungssensor (Android/implizit) OK."); }
             else { addLogEntry("BERECHTIGUNG (Fallback): Bewegungssensor wird nicht unterstützt!", 'error');}
             addLogEntry("DEBUG v12: Alter Bewegungssensor-Check abgeschlossen.");

            // Orientierung (Alt)
            addLogEntry("DEBUG v12: Füge kleine Pause ein (500ms)..."); await delay(500);
            addLogEntry("DEBUG v12: Prüfe alten Orientierungssensor...");
            if (typeof(DeviceOrientationEvent.requestPermission) === 'function') { /* (wie v11) */
                 addLogEntry("DEBUG v12: 'requestPermission' Orientation-API (Alt) erkannt, fordere an...");
                 try {
                     const state = await DeviceOrientationEvent.requestPermission();
                     permissionsState.orientationOld = (state === 'granted');
                     addLogEntry(`DEBUG v12: BERECHTIGUNG (Fallback): Orientierungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
                 } catch (err) { addLogEntry(`DEBUG v12: BERECHTIGUNG (Fallback): Orientierungssensor-Fehler: ${err.message}`, 'error');}
             } else if ('DeviceOrientationEvent' in window) { permissionsState.orientationOld = true; addLogEntry("DEBUG v12: BERECHTIGUNG (Fallback): Orientierungssensor (Android/implizit) OK."); }
             else { addLogEntry("BERECHTIGUNG (Fallback): Orientierungssensor wird nicht unterstützt!", 'error');}
             addLogEntry("DEBUG v12: Alter Orientierungssensor-Check abgeschlossen.");

        } else {
             activeSensorMode = 'new';
             addLogEntry("DEBUG v12: Neue Generic Sensors werden verwendet.");
        }

        // --- v12: Compute Pressure ---
        addLogEntry("DEBUG v12: Prüfe Compute Pressure API...");
        if ('ComputePressureObserver' in window) {
             permissionsState.cpu = true;
             addLogEntry("DEBUG v12: BERECHTIGUNG: Compute Pressure API gefunden.");
             // Keine explizite Berechtigung nötig, aber wir prüfen Verfügbarkeit
        } else {
             addLogEntry("BERECHTIGUNG: Compute Pressure API wird nicht unterstützt!", 'warn');
        }
        addLogEntry("DEBUG v12: Compute Pressure Check abgeschlossen.");


        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps; // GPS bleibt das Minimum
    }


    // Phase B: Startet alle Logger (Dynamisch je nach Modus)
    function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger (v12)...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. GPS-Logger (Immer)
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        addLogEntry("DEBUG: 'geolocation.watchPosition' Listener angehängt.");
        
        // 2. Netzwerk-Polling (Immer, falls API da)
        if (permissionsState.network) {
            networkCheckInterval = setInterval(checkNetworkState, NETWORK_POLL_INTERVAL_MS);
            addLogEntry(`DEBUG: Netzwerk-Polling-Timer gestartet (Intervall: ${NETWORK_POLL_INTERVAL_MS}ms).`);
            checkNetworkState(true); 
        }

        // 3. v12: Compute Pressure Observer (Falls API da)
        if (permissionsState.cpu) {
            try {
                pressureObserver = new ComputePressureObserver(
                    updates => { updates.forEach(handleComputePressureUpdate); },
                    { cpuUtilizationThresholds: [0.5, 0.8], cpuSpeedThresholds: [0.6] } // Beispiel-Schwellenwerte
                );
                pressureObserver.observe();
                addLogEntry("DEBUG: 'ComputePressureObserver' gestartet.");
            } catch (cpuErr) {
                 addLogEntry(`FEHLER beim Starten des ComputePressureObserver: ${cpuErr.message}`, 'error');
                 permissionsState.cpu = false; // Deaktivieren
            }
        }

        // 4. Motion/Orientation - ENTWEDER NEU ODER ALT
        if (activeSensorMode === 'new') {
            addLogEntry("DEBUG: Starte NEUE Generic Sensors...");
            try {
                if (permissionsState.accelNew) {
                    accelerometer = new Accelerometer({ frequency: SENSOR_FREQUENCY });
                    accelerometer.addEventListener('reading', handleNewAccelerometerReading);
                    accelerometer.addEventListener('error', (e) => handleGenericSensorError(e, 'Accelerometer'));
                    accelerometer.start();
                    addLogEntry("DEBUG: 'Accelerometer' (New API) gestartet.");
                } else { throw new Error("Keine Berechtigung für Accelerometer"); }

                if (permissionsState.gyroNew) {
                    gyroscope = new Gyroscope({ frequency: SENSOR_FREQUENCY });
                    gyroscope.addEventListener('reading', handleNewGyroscopeReading);
                    gyroscope.addEventListener('error', (e) => handleGenericSensorError(e, 'Gyroscope'));
                    gyroscope.start();
                    addLogEntry("DEBUG: 'Gyroscope' (New API) gestartet.");
                } else { throw new Error("Keine Berechtigung für Gyroscope"); }

                if (permissionsState.lightNew && 'AmbientLightSensor' in window) { // Nur starten, wenn API wirklich da ist
                     ambientLightSensor = new AmbientLightSensor({ frequency: 1 }); // 1Hz reicht für Licht
                     ambientLightSensor.addEventListener('reading', handleAmbientLightReading);
                     ambientLightSensor.addEventListener('error', (e) => handleGenericSensorError(e, 'AmbientLightSensor'));
                     ambientLightSensor.start();
                     addLogEntry("DEBUG: 'AmbientLightSensor' (New API) gestartet.");
                }

            } catch (newSensorErr) {
                 addLogEntry(`FEHLER beim Starten der NEUEN Sensoren: ${newSensorErr.message}. VERSUCHE FALLBACK...`, 'error');
                 activeSensorMode = 'old'; // Fallback erzwingen
                 // Berechtigungen für Fallback sollten schon geprüft sein
                 permissionsState.accelNew = false; permissionsState.gyroNew = false; permissionsState.lightNew = false;
                 // ** WICHTIG: Alte Sensoren jetzt starten! **
                 startFallbackSensors();
            }
        } else {
             // 5. Fallback: Alte Sensoren starten
             startFallbackSensors();
        }
        
        isLogging = true;
        startBtn.disabled = true;
        permissionBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;
    }

    // v12: Hilfsfunktion zum Starten der alten Fallback-Sensoren
    function startFallbackSensors() {
        addLogEntry("DEBUG: Starte ALTE Fallback-Sensoren (Motion/Orientation)...");
        if (permissionsState.motionOld) {
            window.addEventListener('devicemotion', logDeviceMotionFallback);
            addLogEntry("DEBUG: 'devicemotion' (Fallback) Listener angehängt.");
        } else {
            addLogEntry("WARNUNG: Bewegungssensor (Fallback) Listener NICHT angehängt.", 'warn');
        }
        if (permissionsState.orientationOld) {
            window.addEventListener('deviceorientation', logDeviceOrientationFallback);
            addLogEntry("DEBUG: 'deviceorientation' (Fallback) Listener angehängt.");
        } else {
            addLogEntry("WARNUNG: Orientierungssensor (Fallback) Listener NICHT angehängt.", 'warn');
        }
    }


    // ===================================
    // --- BUTTON-HANDLER (v12) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => { /* (Logik wie v11) */
        permissionBtn.disabled = true;
        startBtn.disabled = true;
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "";
        lastNetworkType = ""; lastCpuState = 'nominal';
        permissionsState = { gps: false, network: false, motionOld: false, orientationOld: false, accelNew: false, gyroNew: false, lightNew: false, cpu: false };

        const gpsOk = await requestAllPermissions();

        if (gpsOk) {
            statusEl.textContent = "Bereit zum Loggen! (GPS OK)";
            startBtn.disabled = false; downloadBtn.disabled = true; permissionBtn.disabled = true;
        } else {
            statusEl.textContent = "Fehler: GPS-Berechtigung benötigt!";
            permissionBtn.disabled = false;
        }
    };

    // START
    startBtn.onclick = () => { /* (Logik wie v11) */
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "";
        motionSensorHasFired = false; orientationSensorHasFired = false;
        lastNetworkType = ""; lastCpuState = 'nominal';

        addLogEntry(`Logging-Prozess angefordert (v12)...`);
        startAllLoggers();
    };

    // STOP
    stopBtn.onclick = () => { /* (Angepasst für v12) */
        if (!isLogging) return;
        
        addLogEntry("Versuche, alle Logger zu stoppen...");
        statusEl.textContent = "Stoppe Logger...";

        // Standard Listener & Timer
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null;
        if (networkCheckInterval) clearInterval(networkCheckInterval); networkCheckInterval = null;
        
        // Compute Pressure
        if (pressureObserver) { try { pressureObserver.unobserve(); } catch(e){} pressureObserver = null; }

        // Alte Sensoren
        window.removeEventListener('devicemotion', logDeviceMotionFallback);
        window.removeEventListener('deviceorientation', logDeviceOrientationFallback);

        // Neue Sensoren
        [accelerometer, gyroscope, ambientLightSensor].forEach(sensor => {
            if (sensor) {
                 try { sensor.stop(); } catch(e){}
                 // WICHTIG: Event Listener entfernen, sonst gibt es Memory Leaks!
                 if (sensor instanceof Accelerometer) {
                     sensor.removeEventListener('reading', handleNewAccelerometerReading);
                     sensor.removeEventListener('error', handleGenericSensorError);
                 } else if (sensor instanceof Gyroscope) {
                      sensor.removeEventListener('reading', handleNewGyroscopeReading);
                      sensor.removeEventListener('error', handleGenericSensorError);
                 } else if (sensor instanceof AmbientLightSensor) {
                      sensor.removeEventListener('reading', handleAmbientLightReading);
                      sensor.removeEventListener('error', handleGenericSensorError);
                 }
            }
        });
        accelerometer = null; gyroscope = null; ambientLightSensor = null;

        isLogging = false;
        flightRecorderBuffer = []; // Leeren nach Stop
        addLogEntry("Logging gestoppt.");

        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = true; permissionBtn.disabled = false;
        stopBtn.disabled = true; crashBtn.disabled = true; downloadBtn.disabled = false;
    };

    // ABSTURZ MARKIEREN
    crashBtn.onclick = () => { /* (Logik wie v11) */
        if (!isLogging) return;
        const markerTime = getTimestamp();
        dumpFlightRecorder(markerTime, "ABSTURZ VOM NUTZER MARKIERT");
        statusEl.textContent = "ABSTURZ MARKIERT & DUMP ERSTELLT!";
        setTimeout(() => { if(isLogging) statusEl.textContent = "LOGGING..."; }, 3000);
    };

    // DOWNLOAD
    downloadBtn.onclick = () => { /* (Angepasst für v12) */
        if (logEntries.length === 0) { alert("Keine Logs zum Herunterladen vorhanden."); return; }
        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain;charset=utf-8' }); // UTF-8 für alle Zeichen
        const filename = `waze_log_v12_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(a.href); // Speicher freigeben
    };

    // Initialen Button-Status setzen
    startBtn.disabled = true; stopBtn.disabled = true; crashBtn.disabled = true; downloadBtn.disabled = true;
}); 
