const open = require('open');
const express = require('express');
const path = require('path');

// Auth libs
const pkce = require('pkce');

// Config
const client_id = '850dbd9b43904e2cb1bee51c7d88ff47';
const port = 9753;
const redirect_uri = `http://localhost:${port}/cb`;
const scope = 'user-read-playback-state';

const state = pkce.createChallenge(); // Too lazy to make my own random stuff

// Start HTTP server
const app = express();

app.get('/cb', (req, res) => {
  const newState = req.query.state;
  const authCode = req.query.code;

  if (state !== newState) {
    console.log('Error encountered, please restart application.');
  }

  res.sendFile(path.join(__dirname, 'public', 'cb.html'));
});

app.listen(port, () => {
  console.log(`Please authorize YASNPA to access your Spotify currently playing data.`);
});

(async () => {
  // Generate Code Verifier and Code Challenge
  const codePair = pkce.create();

  // Open URI with browser to get user auth tokens
  const authURI = generateAuthURI(codePair.codeChallenge, state);
  await open(authURI, {
    url: true,
  });
})();




function generateAuthURI(codeChallenge, state) {
  const response_type = 'code';
  const code_challenge_method = 'S256';
  const code_challenge = codeChallenge;

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