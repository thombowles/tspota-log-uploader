// Global Variables for Contest Bands (non-WARC) in kHz
const CONTEST_BANDS = [1800, 3500, 7000, 14000, 21000, 28000];

// Global Variables for Contest Start and End Times (UTC)
// Format: landlab-MM-DDTHH:MM:SSZ (ISO 8601 UTC)
// Example: '2024-10-19T00:00:00Z' (October 19, 2024, 00:00:00 UTC)
const CONTEST_START_UTC = '1999-01-01T00:00:00Z';
const CONTEST_END_UTC = '2025-12-31T23:59:59Z';

// Global Variable for Contest Band Ranges in kHz
const BAND_RANGES = {
  "160m": { start: 1800, end: 2000 },
  "80m": { start: 3500, end: 4000 },
  "40m": { start: 7000, end: 7300 },
  "20m": { start: 14000, end: 14350 },
  "15m": { start: 21000, end: 21450 },
  "10m": { start: 28000, end: 29700 },
};

// Global Variable for Google Sheet ID
const SHEET_ID = 'SHEET_ID'; // Replace with your Google Sheet ID

// Global Variable for Google Drive Folder ID
const DRIVE_FOLDER_ID = 'FOLDER_ID'; // Replace with your Google Drive Folder ID

// ID of the Google Sheet containing valid park references
const PARK_REF_SHEET_ID = 'PARK_REF_SHEET_ID';

function doGet(e) {
    // Serve the HTML file
    return HtmlService.createTemplateFromFile('index')
        .evaluate()
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function processLog(fileBase64, callsign, fileName, operatorClass, power, email, clubCallsign, photoBase64, reportText) {
    try {
        Logger.log(`CONTEST_START_UTC: ${CONTEST_START_UTC}`);
        Logger.log(`CONTEST_END_UTC: ${CONTEST_END_UTC}`);

        // Decode the Base64 file content
        const fileBlob = Utilities.newBlob(Utilities.base64Decode(fileBase64), "application/octet-stream", fileName);

        // Validate ADIF file
        const adifContent = fileBlob.getDataAsString();
        if (!isValidADIF(adifContent)) {
            throw new Error("Invalid ADIF file.");
        }

        // Parse ADIF content
        const qsos = parseADIF(adifContent);

        // Get valid park references from the Google Sheet
        const validParkRefs = getValidParkRefs();

        // Validate QSOs
        const contestStartDateTime = new Date(CONTEST_START_UTC);
        const contestEndDateTime = new Date(CONTEST_END_UTC);

        // Filter QSOs where STATION_CALLSIGN matches the provided callsign
        const matchingQsos = qsos.filter(qso => {
            const stationCallsign = qso.station_callsign ? qso.station_callsign.toUpperCase() : '';
            return stationCallsign === callsign.toUpperCase();
        });

        // Check if any QSOs have a matching STATION_CALLSIGN
        if (matchingQsos.length === 0) {
            throw new Error("No QSOs found with matching STATION_CALLSIGN.");
        }
        
        // Continue with QSO validation using only the matching QSOs
        const validationResult = validateQsos(matchingQsos, contestStartDateTime, contestEndDateTime, validParkRefs, operatorClass);
        const validatedQsos = validationResult.validQsos;

        // Get invalid QSOs with non-matching STATION_CALLSIGN separately
        const nonMatchingQsos = qsos.filter(qso => {
            const stationCallsign = qso.station_callsign ? qso.station_callsign.toUpperCase() : '';
            return stationCallsign !== callsign.toUpperCase();
        });

        // Add a new reason for invalid QSOs with non-matching STATION_CALLSIGN
        const invalidQsos = validationResult.invalidQsos.concat(
            nonMatchingQsos.map(qso => ({
                callsign: qso.call,
                reasons: ["Station callsign mismatch"],
                timestamp: qso.qso_date + ' ' + qso.time_on
            }))
        );

        // Check if any QSOs are within the contest period
        if (validatedQsos.length === 0) {
            throw new Error("No QSOs found within the contest period.");
        }

        // Identify and handle duplicate QSOs
        const uniqueContacts = new Set();
        const duplicateQsos = [];
        const finalValidatedQsos = [];

        validatedQsos.forEach(qso => {
            const band = qso.band;
            const mode = qso.mode;
            const callsign = qso.call;

            // Use the correct field based on operator class for park multipliers
            const parkRef = operatorClass !== 'SO' ?
                (qso.my_pota_ref || qso.my_sig_info || '').trim().toUpperCase() :
                (qso.pota_ref || qso.sig_info || '').trim().toUpperCase();

            // Create a unique key for each contact
            const contactKey = `${band}-${mode}-${callsign}-${parkRef}`;

            // Check if the contact is unique
            if (!uniqueContacts.has(contactKey)) {
                uniqueContacts.add(contactKey);
                finalValidatedQsos.push(qso);
            } else {
                Logger.log("Duplicate QSO found: " + contactKey);
                duplicateQsos.push({ callsign: qso.call, reasons: ["Duplicate"], park: parkRef, timestamp: qso.qso_date + ' ' + qso.time_on });
            }
        });

        // Combine invalid and duplicate QSOs
        const allInvalidQsos = invalidQsos.concat(duplicateQsos);

        // Calculate score
        const powerMultiplier = getPowerMultiplier(power);
        const scoreDetails = calculateScore(finalValidatedQsos, operatorClass, validParkRefs, powerMultiplier);
        const score = scoreDetails.totalScore;

        // Store ADIF file in Google Drive
        const formattedDate = Utilities.formatDate(new Date(), "GMT", "yyyyMMdd_HHmmss");
        const driveFileName = formattedDate + "_" + callsign + "_" + fileName;
        const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
        const storedFile = folder.createFile(fileBlob).setName(driveFileName);
        const fileUrl = storedFile.getUrl(); // Get the URL of the stored file

        // Process photo and report for Activators
        let photoUrl = "";
        if (operatorClass !== 'SO' && photoBase64) {
            try {
                const photoBlob = Utilities.newBlob(Utilities.base64Decode(photoBase64), "image/jpeg", formattedDate + "_" + callsign + "_photo.jpg");
                const photoFile = folder.createFile(photoBlob);
                photoUrl = photoFile.getUrl();
            } catch (error) {
                Logger.log("Error processing photo: " + error.toString());
                // Handle the error appropriately, e.g., set photoUrl to an error message
                photoUrl = "Error processing photo";
            }
        }      

        // Store data in Google Sheet
        const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet(); // Define sheet variable here

        // Get the header row to determine column indices
        const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        
        // Column indices for main data
        const callsignIndex = headerRow.indexOf('Callsign') + 1;
        const scoreIndex = headerRow.indexOf('Score') + 1;
        const validQsosIndex = headerRow.indexOf('Valid QSOs') + 1;
        const operatorClassIndex = headerRow.indexOf('Operator Class') + 1;
        const powerIndex = headerRow.indexOf('Power') + 1;
        const qsoPointsIndex = headerRow.indexOf('QSO Points') + 1;
        const powerMultiplierIndex = headerRow.indexOf('Power Multiplier') + 1;
        const parksWorkedMultiplierIndex = headerRow.indexOf('Parks Worked Multiplier') + 1;
        const parksActivatedMultiplierIndex = headerRow.indexOf('Parks Activated Multiplier') + 1;
        const uniqueParksWorkedIndex = headerRow.indexOf('Unique Parks Worked') + 1;
        const uniqueParksActivatedIndex = headerRow.indexOf('Unique Parks Activated') + 1;
        const fileUrlIndex = headerRow.indexOf('File URL') + 1;
        const emailIndex = headerRow.indexOf('Email') + 1;
        const clubCallsignIndex = headerRow.indexOf('Club Callsign') + 1;

        // New column indices for report text and photo link
        const reportTextIndex = headerRow.indexOf('Report Text') + 1; 
        const photoLinkIndex = headerRow.indexOf('Photo Link') + 1; 

        // Column indices for bonuses
        const k5lrkColumnIndex = headerRow.indexOf('K5LRK Bonus') + 1;
        const parksActivatedColumnIndex = headerRow.indexOf('Parks Activated Bonus') + 1;
        const activatorInThreeParksBonusIndex = headerRow.indexOf('Activator in 3 Parks Bonus') + 1;
        const photoAndReportBonusIndex = headerRow.indexOf('Photo and Report Bonus') + 1;

        // Column indices for QSO counts
        const cwDigitalQsosIndex = headerRow.indexOf('CW/Digital QSOs') + 1;
        const phoneQsosIndex = headerRow.indexOf('Phone QSOs') + 1;

        // Append the main data to the sheet
        let dataToAppend = [
            formattedDate,
            callsign,
            score,
            finalValidatedQsos.length,
            operatorClass,
            power,
            scoreDetails.qsoPoints,
            scoreDetails.cwDigitalQsos, // Add CW/Digital QSO count
            scoreDetails.phoneQsos,     // Add Phone QSO count
            powerMultiplier,
            scoreDetails.parksWorkedMultiplier,
            scoreDetails.parksActivatedMultiplier,
            scoreDetails.uniqueParksWorked.join(','),
            scoreDetails.uniqueParksActivated.join(','),
            fileUrl,
            email,
            clubCallsign
        ];

        // Insert report text and photo URL at their correct positions
        dataToAppend.splice(reportTextIndex - 1, 0, reportText); // Insert reportText
        dataToAppend.splice(photoLinkIndex - 1, 0, photoUrl); // Insert photoUrl

        sheet.appendRow(dataToAppend);

        // Append the bonus values to the row
        const currentRow = sheet.getLastRow();
        sheet.getRange(currentRow, k5lrkColumnIndex).setValue(scoreDetails.bonusK5LRK);
        sheet.getRange(currentRow, parksActivatedColumnIndex).setValue(scoreDetails.bonusParksActivated);
        sheet.getRange(currentRow, activatorInThreeParksBonusIndex).setValue(scoreDetails.bonusActivatorInThreeParks);
        
        // Award bonus points if photo and report are submitted by an Activator
        let bonusPhotoAndReport = 0;
        if (operatorClass !== 'SO' && reportText && photoUrl && photoUrl != "Error processing photo") {
            bonusPhotoAndReport = 50;
        }
        sheet.getRange(currentRow, photoAndReportBonusIndex).setValue(bonusPhotoAndReport); // Photo and Report Bonus
        
        // Update total score in the sheet with the new bonus
        const newTotalScore = score + bonusPhotoAndReport;
        const scoreColumnIndex = headerRow.indexOf('Score') + 1; // Assuming 'Score' is the column name for the total score
        sheet.getRange(currentRow, scoreColumnIndex).setValue(newTotalScore);

        // Prepare summary message
        let summaryMessage = `Log processed successfully.<br>`;
        summaryMessage += `<br> Operator Class: ${operatorClass}`; // Add operator class
        summaryMessage += `<br> Power: ${power}`; // Add power
        summaryMessage += `<br> QSO Points: ${scoreDetails.qsoPoints}`;
        summaryMessage += `<br> CW/Digital QSOs: ${scoreDetails.cwDigitalQsos}`; // Add CW/Digital QSO count
        summaryMessage += `<br> Phone QSOs: ${scoreDetails.phoneQsos}`;         // Add Phone QSO count
        summaryMessage += `<br> Power Multiplier: ${powerMultiplier}`;
        if (operatorClass !== 'SO') {
            summaryMessage += `<br> Parks Activated Multiplier: ${scoreDetails.parksActivatedMultiplier}`;
            if (scoreDetails.uniqueParksActivated.length > 0) {
                summaryMessage += `<br> Parks Activated: ${scoreDetails.uniqueParksActivated.join(', ')}`;
            }
        }
        summaryMessage += `<br> Parks Worked Multiplier: ${scoreDetails.parksWorkedMultiplier}`;
        if (scoreDetails.uniqueParksWorked.length > 0) {
            summaryMessage += `<br> Parks Worked: ${scoreDetails.uniqueParksWorked.join(', ')}`;
        }

        // Add bonus points information to the summary
        let bonusPointsTotal = 0;
        const bonusList = [];
        if (scoreDetails.bonusK5LRK > 0) {
            bonusList.push(`K5LRK Bonus: ${scoreDetails.bonusK5LRK}`);
            bonusPointsTotal += scoreDetails.bonusK5LRK;
        }
        if (scoreDetails.bonusParksActivated > 0) {
            bonusList.push(`Parks Activated Bonus: ${scoreDetails.bonusParksActivated}`);
            bonusPointsTotal += scoreDetails.bonusParksActivated;
        }
        if (scoreDetails.bonusActivatorInThreeParks > 0) {
            bonusList.push(`Activator in 3 Parks Bonus: ${scoreDetails.bonusActivatorInThreeParks}`);
            bonusPointsTotal += scoreDetails.bonusActivatorInThreeParks;
        }
        if (bonusPhotoAndReport > 0) {
            bonusList.push(`Photo and Report Bonus: ${bonusPhotoAndReport}`);
            bonusPointsTotal += bonusPhotoAndReport;
        }

        if (bonusList.length > 0) {
            summaryMessage += `<br> Bonuses Applied:`;
            bonusList.forEach(bonus => summaryMessage += `<br> - ${bonus}`);
            summaryMessage += `<br> Total Bonus Points: ${bonusPointsTotal}`;
        }

        summaryMessage += `<br> Total Score: ${newTotalScore}`;
        summaryMessage += `<br> Valid QSOs: ${finalValidatedQsos.length}`;

        // Modify the summary message generation to include the new invalid reason
        if (allInvalidQsos.length > 0) {
            summaryMessage += `, Invalid QSOs: ${allInvalidQsos.length}`;
            allInvalidQsos.forEach(qso => {
                summaryMessage += `<br> - ${qso.callsign} (${qso.timestamp}): ${qso.reasons.join('; ')}`;
            });
        }

        // Return success response with summary
        Logger.log(summaryMessage);
        return { score: newTotalScore, message: summaryMessage };

    } catch (error) {
        // Handle errors and log them
        Logger.log(`Error processing log: ${error.message}`);
        return { score: 0, message: "Error: " + error.message };
    }
}

function isValidADIF(content) {
    // Check for <eoh> tag to indicate a valid header
    if (!content.toLowerCase().includes("<eoh>")) {
        return false;
    }

    // Check for at least one <eor> tag to indicate presence of QSO records
    if (!content.toLowerCase().includes("<eor>")) {
        return false;
    }

    // Check for <ADIF_VER tag to indicate presence of version
    if (!content.toLowerCase().includes("<adif_ver")) {
        return false;
    }

    return true;
}

function parseADIF(content) {
    const qsos = [];
    const endOfHeaderIndex = content.toLowerCase().indexOf("<eoh>");

    if (endOfHeaderIndex === -1) {
        throw new Error("Invalid ADIF file: Could not find <EOH> marker");
    }

    const headerContent = content.substring(0, endOfHeaderIndex);
    const recordsContent = content.substring(endOfHeaderIndex + 5); // +5 to skip "<eoh>\n"

    const qsoRecords = recordsContent.trim().split(/<eor>/i);

    for (const record of qsoRecords) {
        if (record.trim() === "") continue;

        const qso = {};
        const fieldMatches = record.matchAll(/<([^:]+):(\d+)(:[^>]+)?>([^<]+)/gi);

        for (const match of fieldMatches) {
            const fieldName = match[1].toLowerCase();
            const fieldLength = parseInt(match[2]);
            const fieldType = match[3] ? match[3].slice(1).toLowerCase() : null;
            const fieldValue = match[4].trim(); // Trim whitespace

            if (fieldValue.length !== fieldLength) {
                Logger.log(`Field length mismatch for ${fieldName}: expected ${fieldLength}, got ${fieldValue.length}`);
                // You can choose to handle this error as needed
            }

            qso[fieldName] = fieldValue;
        }

        qsos.push(qso);
    }

    return qsos;
}

function getValidParkRefs() {
    const ss = SpreadsheetApp.openById(PARK_REF_SHEET_ID);
    const sheet = ss.getSheetByName("Parks"); // Or whichever sheet has the park data
    const values = sheet.getDataRange().getValues();

    // Assuming the park references are in the first column
    // Skip the header row (if any) and map to get just the park refs
    const parkRefs = values.slice(1).map(row => row[0].trim().toUpperCase());

    return parkRefs;
}

function validateQsos(qsos, contestStart, contestEnd, validParkRefs, operatorClass) {
  const validQsos = [];
  const invalidQsos = [];

  qsos.forEach(qso => {
    const qsoDateTime = parseADIFDate(qso.qso_date, qso.time_on);
    const invalidReasons = [];

    // Get frequency in kHz from either 'freq' or 'band' field
    let qsoFrequencykHz;
    let qsoBand;
    if (qso.freq) {
      qsoFrequencykHz = parseFloat(qso.freq) * 1000; // Convert MHz to kHz
      qsoBand = qso.freq + 'MHz';
    } else if (qso.band) {
      const bandRange = BAND_RANGES[qso.band.toLowerCase()];
      if (bandRange) {
        qsoFrequencykHz = (bandRange.start + bandRange.end) / 2;
        qsoBand = qso.band;
      } else {
        invalidReasons.push(`Invalid band: ${qso.band}`);
        qsoBand = qso.band;
      }
    } else {
      invalidReasons.push('No frequency information found');
    }

    // Check if the QSO time is within the contest period
    const isWithinContestPeriod = qsoDateTime.getTime() >= contestStart.getTime() &&
                                 qsoDateTime.getTime() <= contestEnd.getTime();
    if (!isWithinContestPeriod) {
      invalidReasons.push('Outside contest period');
    }

    // Check if the QSO frequency is within a valid band range
    const isValidFrequency = Object.values(BAND_RANGES).some(range =>
      qsoFrequencykHz >= range.start && qsoFrequencykHz <= range.end
    );
    if (!isValidFrequency) {
      invalidReasons.push(`Invalid frequency: ${qsoBand}`);
    }

    // Validate the park reference if not SO
    if (operatorClass !== 'SO'){
        const parkRef = (qso.my_pota_ref || qso.my_sig_info || '').trim().toUpperCase();
        const isValidPark = validParkRefs.includes(parkRef);
        if (!isValidPark) {
        invalidReasons.push(`Invalid park reference: ${parkRef}`);
        }
    }

    // Log the validity of the QSO
    if (invalidReasons.length === 0) {
      Logger.log("QSO valid");
      validQsos.push(qso);
    } else {
      Logger.log("QSO Invalid");
      invalidQsos.push({ callsign: qso.call, reasons: invalidReasons, timestamp: qso.qso_date + ' ' + qso.time_on, band: qsoBand });
    }
});

return { validQsos, invalidQsos };
}

function getUniqueParks(qsos, isActivator) {
  const parks = new Set();
  qsos.forEach(qso => {
    const parkRefField = isActivator ? (qso.my_pota_ref || qso.my_sig_info) : (qso.pota_ref || qso.sig_info);
    const parkRef = (parkRefField || '').trim().toUpperCase();
    if (parkRef) {
      parks.add(parkRef);
    }
  });
  return Array.from(parks);
}

function calculateScore(qsos, operatorClass, validParkRefs, powerMultiplier) {
  let qsoPoints = 0;
  let cwDigitalQsos = 0;
  let phoneQsos = 0;
  const contacts = new Set(); // Keep track of unique contacts per band, mode, and park

  qsos.forEach(qso => {
    const band = qso.band;
    const mode = qso.mode.toUpperCase(); // Convert mode to uppercase for consistency
    const callsign = qso.call;

    // Use the correct field based on operator class for park multipliers
    const parkRef = operatorClass !== 'SO' ?
      (qso.my_pota_ref || qso.my_sig_info || '').trim().toUpperCase() :
      (qso.pota_ref || qso.sig_info || '').trim().toUpperCase();

    // Create a unique key for each contact
    const contactKey = `${band}-${mode}-${callsign}-${parkRef}`;

    // Check if the contact is unique
    if (!contacts.has(contactKey)) {
      contacts.add(contactKey);

      // Determine if the QSO is CW/Digital or Phone based on ADIF spec
      if (isCwDigitalMode(mode)) {
        qsoPoints += 2; // 2 points for CW/Digital
        cwDigitalQsos++;
      } else if (isPhoneMode(mode)) {
        qsoPoints += 1; // 1 point for Phone
        phoneQsos++;
      }
    }
  });

  // Bonus points for working K5LRK (Host Club Station)
  let bonusK5LRK = 0;
  const k5lrkContacts = qsos.filter(qso => qso.call.toUpperCase() === 'K5LRK');
  if (k5lrkContacts.length > 0) {
    bonusK5LRK = 5; 
  }

  // Bonus for activating more than 3 parks 
  let bonusParksActivated = 0;
  if (operatorClass !== 'SO' && getUniqueParks(qsos, true).length > 3) {
    bonusParksActivated = 50;
  }

  // Initialize bonus points for working the same activator in 3 different parks
  let bonusActivatorInThreeParks = 0;

  // Calculate bonus for working the same activator in 3 different parks (Searchers only)
  if (operatorClass === 'SO') {
    const activatorParkCounts = {}; // { activatorCall: { park1: 1, park2: 1, ... } }

    qsos.forEach(qso => {
      const activatorCall = qso.call.toUpperCase();
      const parkRef = (qso.pota_ref || qso.sig_info || '').trim().toUpperCase();

      if (parkRef) { // Only consider QSOs with a valid park reference
        if (!activatorParkCounts[activatorCall]) {
          activatorParkCounts[activatorCall] = new Set();
        }
        activatorParkCounts[activatorCall].add(parkRef);
      }
    });

    // Check if any activator has been worked in 3 or more different parks
    for (const activator in activatorParkCounts) {
      if (activatorParkCounts[activator].size >= 3) {
        bonusActivatorInThreeParks = 50;
        break; // Only award the bonus once
      }
    }
  }

  // Calculate multipliers
  const uniqueParksWorked = getUniqueParks(qsos, false).length;
  const uniqueParksActivated = operatorClass !== 'SO' ? getUniqueParks(qsos, true).length : 0;

  // Calculate QSO Score
  const qsoScore = qsoPoints * powerMultiplier;

    // Calculate Total Score with Bonuses
  const totalScore = qsoScore * (uniqueParksWorked + uniqueParksActivated) + 
                     bonusK5LRK + bonusParksActivated + bonusActivatorInThreeParks;

  return {
    totalScore,
    qsoPoints,
    cwDigitalQsos, // Add CW/Digital QSO count
    phoneQsos,     // Add Phone QSO count
    powerMultiplier,
    parksWorkedMultiplier: uniqueParksWorked,
    parksActivatedMultiplier: uniqueParksActivated,
    uniqueParksWorked: getUniqueParks(qsos, false),
    uniqueParksActivated: operatorClass !== 'SO' ? getUniqueParks(qsos, true) : [],
    bonusK5LRK,
    bonusParksActivated,
    bonusActivatorInThreeParks
  };
}

// Helper function to determine if a mode is CW/Digital
function isCwDigitalMode(mode) {
  const cwDigitalModes = new Set([
    'CW', 'RTTY', 'FT8', 'FT4', 'PSK', 'PSK31', 'PSK63', 'PSK125',
    'OLIVIA', 'CONTESTI', 'JT65', 'JT9', 'FST4', 'FST4W', 'JS8',
    'HELL', 'MFSK', 'Q65'
    // Add other CW/Digital modes from the ADIF spec as needed
  ]);
  return cwDigitalModes.has(mode);
}

// Helper function to determine if a mode is Phone
function isPhoneMode(mode) {
  const phoneModes = new Set([
    'SSB', 'AM', 'FM', 'DV' // DV (Digital Voice) is considered Phone
    // Add other Phone modes from the ADIF spec as needed
  ]);
  return phoneModes.has(mode);
}

function getPowerMultiplier(power) {
  power = power.toUpperCase();
  if (power === 'QRP') {
    return 3;
  } else if (power === 'LOW') {
    return 2;
  } else {
    return 1; // HIGH or default
  }
}

function parseADIFDate(dateStr, timeStr) {
  // Trim whitespace from the date and time strings
  dateStr = dateStr.trim();
  timeStr = timeStr.trim();

  // Parse the date and time components correctly
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6)) - 1; // Month is 0-indexed in JavaScript
  const day = parseInt(dateStr.substring(6, 8));
  const hours = parseInt(timeStr.substring(0, 2));
  const minutes = parseInt(timeStr.substring(2, 4));
  const seconds = timeStr.length >= 6 ? parseInt(timeStr.substring(4, 6)) : 0;

  // Log parsed values before creating Date object
  Logger.log(`Parsed values - Year: ${year}, Month: ${month}, Day: ${day}, Hours: ${hours}, Minutes: ${minutes}, Seconds: ${seconds}`);

  return new Date(Date.UTC(year, month, day, hours, minutes, seconds));
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename)
    .getContent();
}