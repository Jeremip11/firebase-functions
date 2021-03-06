import * as functions from 'firebase-functions';
import * as firebase from 'firebase';
import * as https from 'https';
import * as admin from 'firebase-admin';
import { Request, Response } from 'express';

export * from './pubsub-tests';
export * from './database-tests';
export * from './auth-tests';
export * from './firestore-tests';
export * from './https-tests';
const numTests = Object.keys(exports).length; // Assumption: every exported function is its own test.

import 'firebase-functions'; // temporary shim until process.env.FIREBASE_CONFIG available natively in GCF(BUG 63586213)
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebase.initializeApp(firebaseConfig);
console.log('initializing admin');
admin.initializeApp();

// TODO(klimt): Get rid of this once the JS client SDK supports callable triggers.
function callHttpsTrigger(name: string, data: any) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: 'POST',
        host: 'us-central1-' + firebaseConfig.projectId + '.cloudfunctions.net',
        path: '/' + name,
        headers: {
          'Content-Type': 'application/json',
        },
      },
      response => {
        let body = '';
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
      }
    );
    request.on('error', reject);
    request.write(JSON.stringify({ data }));
    request.end();
  });
}

export const integrationTests: any = functions.https.onRequest(
  (req: Request, resp: Response) => {
    let pubsub: any = require('@google-cloud/pubsub')();

    const testId = firebase
      .database()
      .ref()
      .push().key;
    return Promise.all([
      // A database write to trigger the Firebase Realtime Database tests.
      // The database write happens without admin privileges, so that the triggered function's "event.data.ref" also
      // doesn't have admin privileges.
      firebase
        .database()
        .ref(`dbTests/${testId}/start`)
        .set({ '.sv': 'timestamp' }),
      // A Pub/Sub publish to trigger the Cloud Pub/Sub tests.
      pubsub.topic('pubsubTests').publish({ testId }),
      // A user creation to trigger the Firebase Auth user creation tests.
      admin
        .auth()
        .createUser({
          email: `${testId}@fake.com`,
          password: 'secret',
          displayName: `${testId}`,
        })
        .then(userRecord => {
          // A user deletion to trigger the Firebase Auth user deletion tests.
          admin.auth().deleteUser(userRecord.uid);
        }),
      // A firestore write to trigger the Cloud Firestore tests.
      admin
        .firestore()
        .collection('tests')
        .doc(testId)
        .set({ test: testId }),
      // Invoke a callable HTTPS trigger.
      callHttpsTrigger('callableTests', { foo: 'bar', testId }),
    ])
      .then(() => {
        // On test completion, check that all tests pass and reply "PASS", or provide further details.
        console.log('Waiting for all tests to report they pass...');
        let ref = admin.database().ref(`testRuns/${testId}`);
        return new Promise((resolve, reject) => {
          let testsExecuted = 0;
          ref.on('child_added', snapshot => {
            testsExecuted += 1;
            if (!snapshot.val().passed) {
              reject(
                new Error(
                  `test ${snapshot.key} failed; see database for details.`
                )
              );
              return;
            }
            console.log(
              `${snapshot.key} passed (${testsExecuted} of ${numTests})`
            );
            if (testsExecuted < numTests) {
              // Not all tests have completed. Wait longer.
              return;
            }
            // All tests have passed!
            resolve();
          });
        })
          .then(() => {
            ref.off(); // No more need to listen.
            return Promise.resolve();
          })
          .catch(err => {
            ref.off(); // No more need to listen.
            return Promise.reject(err);
          });
      })
      .then(() => {
        console.log('All tests pass!');
        resp.status(200).send('PASS');
      })
      .catch(err => {
        console.log(`Some tests failed: ${err}`);
        resp
          .status(500)
          .send(
            `FAIL - details at https://${
              process.env.GCLOUD_PROJECT
            }.firebaseio.com/testRuns/${testId}`
          );
      });
  }
);
