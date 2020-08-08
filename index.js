const path = require('path');
const open = require('open');
const express = require('express');
const axios = require('axios');
const pkce = require('pkce');
const qs = require('querystring');


/**
    Config
*/
const client_id = '850dbd9b43904e2cb1bee51c7d88ff47';
const port = 9753;
const redirect_uri = `http://localhost:${port}/cb`;
const scope = 'user-read-playback-state';

const spotifyAuthURI = 'https://accounts.spotify.com/authorize?';
const spotifyTokenURI = 'https://accounts.spotify.com/api/token';

const state = pkce.createChallenge(); // Too lazy to make my own random stuff
// Generate Code Verifier and Code Challenge
const codePair = pkce.create();

let access_token, token_type, expires_in, refresh_token, tokenError, tokenIntervalID, nowPlayingData;

/**
    Express Functions
*/

// Start HTTP server
const app = express();

app.get('/cb', (req, res) => {
  const authState = req.query.state;
  const authCode = req.query.code;
  const authError = req.query.error;

  if (state !== authState || typeof(authError) !== 'undefined') {
    sendFile(res, 'error.html');
  } else {
    const reqData = {
      client_id: client_id,
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirect_uri,
      code_verifier: codePair.codeVerifier,
    };

    return requestNewAccessToken(reqData).then((resData) => {
      if (resData.status === 200) {
        sendPublicFile(res, 'success.html');
        return resData;
      } else {
        sendPublicFile(res, 'error.html');
        throw 'Error in requesting access token.';
      }
    }).then((data) => {
      access_token = data.access_token;
      token_type = data.token_type;
      expires_in = data.expires_in;
      refresh_token = data.refresh_token;

      setupRefreshTimeout();

      // Timer for getting now playing data
      tokenIntervalID = setInterval(() => {
        getNowPlayingData();
      }, 1 * 1000);
    }).catch((error) => {
      // console.log(error);
      console.log('Error occurred in retrieving response data.');
      shutdown();
    });
  }
});

// Send file response to requester
function sendPublicFile(res, filename) {
  res.sendFile(path.join(__dirname, 'public', filename));
}


/**
    Utility Functions
*/

// Open browser tab with URI
async function openURI(uri) {
  // Open URI with browser to get user auth tokens
  await open(uri, {
    url: true,
  });
}

// Generate the initial authorization URI
function generateAuthURI() {
  const response_type = 'code';
  const code_challenge_method = 'S256';
  const code_challenge = codePair.codeChallenge;

  const authURI = spotifyAuthURI +
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
  return axios.post(spotifyTokenURI, qs.stringify(reqData)).then((response) => {
    if (response.status === 200) {
      let { access_token, token_type, scope, expires_in, refresh_token } = response.data;
      return {
        status: response.status,
        access_token: access_token,
        token_type: token_type,
        expires_in: expires_in,
        refresh_token: refresh_token,
      }
    } else {
      return {
        status: response.status,
      };
    }
  });
}

function shutdown() {
  clearInterval(tokenIntervalID);
  server.close(() => {
    process.exit();
  });
}


/**
    Timer Functions
*/

function setupRefreshTimeout() {
  // Timer for refreshing access token 10 seconds before it expires
  setTimeout(() => {
    const reqData = {
      grant_type: 'refresh_token',
      refresh_token: refresh_token,
      client_id: client_id,
    };

    return requestNewAccessToken(reqData)
      .then((resData) => {
        if (resData.status === 200) {
          access_token = resData.access_token;
          token_type = resData.token_type;
          expires_in = resData.expires_in;
          refresh_token = resData.refresh_token;


          // Start another timeout so we can refresh again later
          setupRefreshTimeout();
        } else {
          tokenError = resData.status;
        }
      });
  }, (expires_in - 10) * 1000);
}

function getNowPlayingData() {
  if (typeof(tokenError) === 'undefined') {
    // Get now playing data yay

    return axios.get('https://api.spotify.com/v1/me/player', {
      headers: {
        Authorization: `${token_type} ${access_token}`,
      },
    }).then((response) => {
      nowPlayingData = {};

      console.log(response.data);
    }).catch((error) => {
      // console.log(error);
      console.log('Error in retrieving now playing data.')
    });
  } else {
    console.log(`Error code ${tokenError} encountered. Please restart the application. Shutting down...`);
    shutdown();
  }
}


/**
    Start Here
*/

const server = app.listen(port, () => {
  console.log(`Please authorize YASNPA to access your Spotify currently playing data.`);
});

(async () => {
  openURI(generateAuthURI());
})();