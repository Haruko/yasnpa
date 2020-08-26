const path = require('path');
const open = require('open');
const express = require('express');
const axios = require('axios');
const pkce = require('pkce');
const qs = require('querystring');
const fs = require('fs-extra');
const json5 = require('json5');
const iohook = require('iohook');

const dirname = path.dirname(process.execPath);

/*let numRequests = 0;
axios.interceptors.request.use((config) => {
  ++numRequests;
  const now = new Date();

  console.log(`${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}` +
    ` Request made! #${numRequests} ${config.url}`);

  return Promise.resolve(config);
}, (error) => {
  console.log('Interceptor error!');
  // console.log(error);
  return Promise.reject(error);
});*/

/**
    Config
*/

const configData = json5.parse(fs.readFileSync(path.join(dirname, 'config.json')));

const repoURI = 'https://github.com/ZoeyBonaventura/yasnpa';
const outputDirArray = configData.outputDir.map((dir) => dir === '[{CURRENT_DIR}]' ? dirname : dir);
const outputDir = path.join(...outputDirArray);
const formatStrings = configData.formatStrings;
const crossfade = configData.crossfade;
const hotkey = configData.hotkey;
const keymapMode = configData.keymapMode;


/**
    System Config
*/

const client_id = '850dbd9b43904e2cb1bee51c7d88ff47';
const port = 9753;
const redirect_uri = `http://localhost:${port}/cb`;
const scope = 'user-read-playback-state';

const apiCallDelay = 10;

const spotifyAuthURI = 'https://accounts.spotify.com/authorize';
const spotifyTokenURI = 'https://accounts.spotify.com/api/token';

const state = pkce.createChallenge(); // Too lazy to make my own random stuff
// Generate Code Verifier and Code Challenge
const codePair = pkce.create();


let server,
  accessToken,
  tokenType,
  expiresIn,
  refreshToken,
  refreshTokenTimeoutID,

  nowPlayingIntervalID,
  endOfSongTimeoutID,

  trackProgressIntervalID,
  trackProgressTimeoutID,
  trackProgress,
  trackProgressLastUpdate,

  previousPlaying,
  previousPlayingFormatted,
  lastBookmarked;


/**
    Express Functions
*/

// Start HTTP server
const app = express();

app.get('/cb', (req, res) => {
  const authState = req.query.state;
  const authCode = req.query.code;
  const authError = req.query.error;

  if (state !== authState || typeof authError !== 'undefined') {
    sendPublicFile(res, 'error.html');
    shutdown();
  } else {
    const reqData = {
      client_id: client_id,
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirect_uri,
      code_verifier: codePair.codeVerifier,
    };

    return requestNewAccessToken(reqData)
      .then((resData) => {
        if (resData.status === 200) {
          sendPublicFile(res, 'success.html');
          return tokenHandler(resData);
        } else {
          sendPublicFile(res, 'error.html');
          throw 'Error requesting access token.';
        }
      }).catch((error) => {
        console.log(`Error "${error}" when processing callback!`);
        shutdown();
      });
  }
});

// Send file response to requester
function sendPublicFile(res, filename) {
  res.sendFile(path.join(__dirname, 'public', filename));
}


/**
    API Functions
*/

async function getNowPlayingCallStack() {
  return getNowPlayingData()
    .then((nowPlaying) => {
      if (typeof nowPlaying !== 'undefined') {
        trackProgress = nowPlaying.progress_ms;
        trackProgressLastUpdate = Date.now();
        nowPlayingFormatted = formatNowPlayingDataObject(nowPlaying);

        if (nowPlaying.item !== null) {
          setupProgressInterval();
          setupEndOfSongTimeout(nowPlayingFormatted, nowPlaying);
          previousPlaying = nowPlaying;
          previousPlayingFormatted = nowPlayingFormatted;
        } else {
          clearTimeout(endOfSongTimeoutID);
          clearTimeout(trackProgressTimeoutID);
          clearInterval(trackProgressIntervalID);
        }

        return outputFileData(nowPlayingFormatted);
      }
    }).catch((error) => {
      console.log(`Error "${error}" when retrieving now playing data from callstack!`);
    });
}

function getNowPlayingData() {
  return axios.get('https://api.spotify.com/v1/me/player', {
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
    },
  }).then((response) => {
    const resData = response.data;

    // Spotify API returns 200 OK with empty string as data if the request was successful, but no devices are found.
    if (resData === '') {
      return {
        is_playing: false,
        repeat_state: 'off',
        shuffle_state: false,

        progress_ms: 0,

        currently_playing_type: 'unknown',
        item: null,
      };
    } else {
      return {
        is_playing: resData.is_playing,
        repeat_state: resData.repeat_state,
        shuffle_state: resData.shuffle_state,

        progress_ms: resData.progress_ms,

        currently_playing_type: resData.currently_playing_type,
        item: resData.item,
      };
    }
  }).catch((error) => {
    console.log(`Error "${error}" when retrieving now playing data from api!`);
    // console.log(error.response.headers);
  });
}


/**
    Auth Functions
*/

// Generate the initial authorization URI
function generateAuthURI() {
  const response_type = 'code';
  const code_challenge_method = 'S256';
  const code_challenge = codePair.codeChallenge;

  const authURI = spotifyAuthURI + '?' +
    `client_id=${client_id}&` +
    `response_type=${response_type}&` +
    `redirect_uri=${redirect_uri}&` +
    `code_challenge_method=${code_challenge_method}&` +
    `code_challenge=${code_challenge}&` +
    `state=${state}&` +
    `scope=${scope}`;

  return authURI;
}

async function requestNewAccessToken(reqData) {
  return axios.post(spotifyTokenURI, qs.stringify(reqData))
    .then((response) => {
      if (response.status === 200) {
        let { access_token, token_type, scope, expires_in, refresh_token } = response.data;

        return storeRefreshToken(refresh_token)
          .catch((error) => {
            console.log(`Error "${error}" when storing refresh token!`);
          }).then(() => {
            return {
              status: response.status,
              access_token: access_token,
              token_type: token_type,
              expires_in: expires_in,
              refresh_token: refresh_token,
            };
          });
      } else {
        return {
          status: response.status,
        };
      }
    });
}

async function tokenHandler(data) {
  console.log('Authorization successful. ' +
    'To exit the application, press Ctrl-C or close the window.');
  accessToken = data.access_token;
  tokenType = data.token_type;
  expiresIn = data.expires_in;
  refreshToken = data.refresh_token;

  // Setup hotkeys
  iohook.registerShortcut(hotkey, (keys) => {
    return bookmarkNowPlaying();
  });

  iohook.start();

  setupRefreshTimeout();

  // Timer for getting now playing data
  return getNowPlayingCallStack()
    .then(() => {
      clearInterval(nowPlayingIntervalID);

      nowPlayingIntervalID = setInterval(() => {
        getNowPlayingCallStack();
      }, apiCallDelay * 1000);
    }).catch((error) => {
      console.log('Error in token handler!');
      throw error;
    });
}


/**
    Timer/Interval Functions
*/

function setupEndOfSongTimeout(nowPlayingFormatted, nowPlaying) {
  const currentTrackData = nowPlayingFormatted.track;
  const previousTrackData = typeof previousPlayingFormatted === 'undefined' ? undefined : previousPlayingFormatted.track;

  // Always reset timeout in case we skip ahead in the song
  clearTimeout(endOfSongTimeoutID);

  // Set up new end of song timeout
  // 1s delay to make sure the song actually ended
  const timeoutLength = currentTrackData.duration_ms - nowPlaying.progress_ms - (crossfade * 1000) + 1000;

  endOfSongTimeoutID = setTimeout(() => {
    return getNowPlayingCallStack()
      .catch((error) => {
        console.log(`Error "${error}" when retrieving now playing data from end of song!`);
      });
  }, timeoutLength);
}

async function setupProgressInterval() {
  const delay = 1000 - (trackProgress % 1000);
  clearTimeout(trackProgressTimeoutID);

  trackProgressTimeoutID = setTimeout(() => {
    clearInterval(trackProgressIntervalID);

    trackProgressIntervalID = setInterval(() => {
      return updateTrackProgress();
    }, 1000);

    return updateTrackProgress();
  }, delay < 1000 ? delay : 0);
}

async function updateTrackProgress() {
  if (typeof previousPlayingFormatted !== 'undefined' && !previousPlayingFormatted.is_paused) {
    const newUpdateTime = Date.now();
    trackProgress += newUpdateTime - trackProgressLastUpdate;
    previousPlayingFormatted.progress_ms = trackProgress;
    previousPlayingFormatted.progress = formatTimeMS(trackProgress);
    trackProgressLastUpdate = newUpdateTime;

    return outputFileData(previousPlayingFormatted);
  }
}

function setupRefreshTimeout() {
  // Timer for refreshing access token 10 seconds before it expires
  clearTimeout(refreshTokenTimeoutID);

  refreshTokenTimeoutID = setTimeout(() => {
    const reqData = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client_id,
    };

    return requestNewAccessToken(reqData)
      .then((resData) => {
        if (resData.status === 200) {
          accessToken = resData.access_token;
          tokenType = resData.token_type;
          expiresIn = resData.expires_in;
          refreshToken = resData.refresh_token;


          // Start another timeout so we can refresh again later
          setupRefreshTimeout();
        } else {
          throw resData.status;
        }
      }).catch((error) => {
        console.log(`Error ${error} when retrieving access token!` +
          'Please delete the "refreshtoken" file if it exists and restart the application.');
        shutdown();
      });
  }, (expiresIn - 10) * 1000);
}


/**
    File Functions
*/

async function outputFileData(trackData) {
  // Format the data strings
  return fs.ensureDir(outputDir)
    .catch((error) => {
      console.log(`Error "${error}" when creating directory!`);
      shutdown();
    }).then(() => {
      const outputData = formatStrings.map((fileData) => {
        return {
          filename: fileData.filename,
          data: processFormatString(fileData.formatString, trackData),
        };
      }).forEach((fileData) => {
        return fs.writeFile(path.join(outputDir, fileData.filename), fileData.data, { flag: 'w' })
          .catch((error) => {
            console.log(`Error "${error} when writing to file "${fileData.filename}"!`);
          });
      });
    });
}

async function storeRefreshToken(refresh_token) {
  if (typeof refresh_token !== 'undefined') {
    return fs.writeFile(path.join(dirname, 'refreshtoken'), refresh_token, { flag: 'w' });
  }
}

function checkForRefreshToken() {
  const filePath = path.join(dirname, 'refreshtoken');
  const fileExists = fs.existsSync(filePath);

  if (fileExists) {
    const token = fs.readFileSync(filePath, { encoding: 'utf8' });

    refreshToken = token;
    expiresIn = 1;

    return true;
  } else {
    return false;
  }
}

async function bookmarkNowPlaying() {
  if (typeof previousPlaying !== 'undefined') {
    const item = previousPlaying.item;

    const artists = item.artists.map((artist) => artist.name).join(', ');
    const track = item.name;
    const url = item.external_urls.spotify;
    const bookmarkText = `"${artists.replace(/"/g, '""')}","${track.replace(/"/g, '""')}","${url.replace(/"/g, '""')}"\n`;

    if (bookmarkText !== lastBookmarked) {
      await fs.writeFile(path.join(dirname, 'output', 'bookmarks.csv'), bookmarkText, { flag: 'a' });
      lastBookmarked = bookmarkText;
    }
  }
}


/**
    Formatting Functions
*/

function formatTimeMS(ms) {
  if (typeof ms === 'number') {
    let progress = Math.floor(ms / 1000);
    const progressHours = Math.floor(progress / 3600);
    progress -= progressHours * 3600;
    const progressMins = Math.floor(progress / 60);
    progress -= progressMins * 60;
    const progressSecs = progress;

    const hrs = progressHours ? String(progressHours).padStart(2, '0') + ':' : '';
    const mins = String(progressMins).padStart(2, '0');
    const secs = String(progressSecs).padStart(2, '0');
    return `${hrs}${mins}:${secs}`;
  } else {
    return '00:00';
  }
}

function formatNowPlayingDataObject(data) {
  const formattedData = {
    is_paused: !data.is_playing,
    repeat_state: data.repeat_state === 'off' ? false : data.repeat_state,
    shuffle_state: data.shuffle_state,

    track: null,
    progress: formatTimeMS(data.progress_ms),
    progress_ms: data.progress_ms,
  };

  // Deal with track
  // track, episode, ad, unknown
  // local files
  const item = data.item;

  let track;

  switch (data.currently_playing_type) {
    case 'track':
      track = {
        title: item.name,
        artist: item.artists.map((artist) => artist.name).join(', '),
        album: item.album.name,
        duration: formatTimeMS(getTrackLength(item)),
        duration_ms: item.duration_ms,
        image: item.album.images[0] ? item.album.images[0].url : null,
      };

      break;
    case 'episode':
      track = {
        title: item.name,
        artist: item.show.name,
        album: null,
        duration: formatTimeMS(getTrackLength(item)),
        duration_ms: item.duration_ms,
        image: item.images[0] ? item.images[0].url : null,
      };

      break;
    case 'ad':
      track = {
        title: 'Advertisement',
        artist: null,
        album: null,
        duration: formatTimeMS(getTrackLength('ad')),
        duration_ms: getTrackLength('ad'),
        image: null,
      };

      break;
    case 'unknown':
    default:
      track = {
        title: 'Unknown',
        artist: null,
        album: null,
        duration: formatTimeMS(getTrackLength('unknown', data.progress_ms)),
        duration_ms: getTrackLength('unknown', data.progress_ms),
        image: null,
      };

      break;
  }

  formattedData.track = track;

  return formattedData;
}

function processFormatString(formatString, nowPlayingData) {
  const trackData = nowPlayingData.track;

  formatString = formatString.replace(/\[\{TITLE\}\]/g, trackData.title ? trackData.title : 'Unknown');
  formatString = formatString.replace(/\[\{ARTIST\}\]/g, trackData.artist ? trackData.artist : 'Unknown');
  formatString = formatString.replace(/\[\{ALBUM\}\]/g, trackData.album ? trackData.album : 'Unknown');
  formatString = formatString.replace(/\[\{LENGTH\}\]/g, trackData.duration ? trackData.duration : '??:??');
  formatString = formatString.replace(/\[\{PROGRESS\}\]/g, nowPlayingData.progress);

  return formatString;
}


/**
    Utility Functions
*/

function shutdown() {
  console.log('Shutting down...');

  clearTimeout(refreshTokenTimeoutID);
  clearTimeout(endOfSongTimeoutID);
  clearTimeout(trackProgressTimeoutID);
  clearInterval(nowPlayingIntervalID);
  clearInterval(trackProgressIntervalID);

  if (typeof server !== 'undefined') {
    server.close(() => {
      process.exit();
    });
  }
}

// Open browser tab with URI
async function openURI(uri) {
  // Open URI with browser to get user auth tokens
  await open(uri, {
    url: true,
  });
}

function getTrackLength(track, progress_ms = 0) {
  if (typeof track === 'object') {
    // Assume it's actually a track or episode
    return track.duration_ms
  } else if (track === 'ad') {
    return 30 * 1000;
  } else if (track === 'unknown') {
    return progress_ms;
  } else {
    return 0;
  }
}


/**
    Start Here
*/

async function init() {
  if (checkForRefreshToken()) {
    console.log('Refresh token found.');

    const reqData = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client_id,
    };

    return requestNewAccessToken(reqData)
      .then((data) => tokenHandler(data))
      .catch((error) => {
        console.log(`Error "${error}" in init!`);
        shutdown();
      });
  } else {
    server = app.listen(port, () => {
      console.log('Please authorize YASNPA to access your Spotify currently playing data.');
    });

    return openURI(generateAuthURI());
  }
}

if (keymapMode) {
  // Print out values for keypresses so users can figure out what numbers
  let pressed = undefined;

  iohook.on('keydown', (event) => {
    if (typeof pressed !== 'undefined') {
      return;
    }

    console.log(event.keycode);
    pressed = event.keycode;
  });

  iohook.on('keyup', (event) => {
    if (pressed === event.keycode) {
      pressed = undefined;
    }
  });

  console.log('Application is currently in keymap mode to allow you to find the correct numbers to use in your hotkey. ' +
    'If you would like to run the application normally, open config.json and change keymapMode to false. ' +
    'To close, press Ctrl-C or close the window.');
  iohook.start();
} else {
  init();
}