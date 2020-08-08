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

const state = pkce.createChallenge(); // Too lazy to make my own random stuff
// Generate Code Verifier and Code Challenge
const codePair = pkce.create();


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
    }

    return requestNewAccessToken(reqData).then((resData) => {
      if (resData.status === 200) {
        sendFile(res, 'success.html');
      } else {
        sendFile(res, 'error.html');
      }
    });
  }
});

app.listen(port, () => {
  console.log(`Please authorize YASNPA to access your Spotify currently playing data.`);
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

  const authURI = `https://accounts.spotify.com/authorize?` +
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
  return axios.post('https://accounts.spotify.com/api/token', qs.stringify(reqData)).then((response) => {
    if (response.status === 200) {
      let { access_token, token_type, scope, expires_in, refresh_token } = response.data;
      return {
        status: response.status,
        access_token: access_token,
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


/**
    Start Here
*/

(async () => {
  openURI(generateAuthURI());
})();