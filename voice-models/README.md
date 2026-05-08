# Wake-word models

Drop a custom-trained openWakeWord ONNX model file in this directory and point
`system.listen_start({ wakeWordModelPath })` at it to override the built-in
default.

## Default behavior (no file in this dir)

The MVP ships with the integration wired against openWakeWord's **`hey_jarvis`**
pre-trained model — the closest 2-word built-in to the user's preferred
"hey coach" phrase. openWakeWord auto-downloads its built-in models on first
sidecar boot, so the listener works end-to-end out of the box without any
file living here.

Other openWakeWord built-ins you can swap to without retraining (pass via
`system.listen_start({ wakeWord: 'alexa' })` etc.):

- `alexa`
- `hey_jarvis`
- `hey_mycroft`
- `hey_rhasspy`
- `timer`
- `weather`

## Training a custom `hey_coach` model

The user-chosen "hey coach" phrase isn't in the pre-trained set. To produce a
custom model:

1. Open the [openWakeWord training notebook](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training_simple.ipynb)
   on Colab (free GPU runtime is sufficient).
2. Set the `target_phrase` cell to `"hey coach"` and run all cells. The
   notebook synthesizes ~10k training utterances via Piper TTS, augments them
   with negative-class data, and trains a small classifier. Total runtime
   ~30–60 minutes on a Colab T4.
3. Download the resulting `.onnx` model and drop it in this directory:
   `voltras-mcp/voice-models/hey-coach.onnx`.
4. Pass it to the listener:
   ```ts
   system.listen_start({
     wakeWordModelPath: "voice-models/hey-coach.onnx",
     // wakeWord arg is informational once a custom path is supplied
   });
   ```

### Optional: improve precision with real samples

After the synthetic-only model is working, record ~20–50 clips of yourself
saying the wake phrase (the notebook has a "real-data fine-tuning" cell that
folds them into the training set). Total user-time: ~30 min. Empirically
halves the false-reject rate on the speaker's own voice.

## Licensing

openWakeWord is Apache-2.0 and its pre-trained models are MIT-licensed weights
hosted on HuggingFace. Models trained from the project's notebook (synthetic
or real data) are redistributable under the same terms — feel free to commit
them here.
