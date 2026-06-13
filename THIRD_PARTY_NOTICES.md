# Third Party Notices

## Handy

Bridge push-to-talk work is inspired by Handy and includes adapted portions of
Handy code for keyboard paste behavior in the native voice sidecar.

Repository: https://github.com/cjpais/Handy

MIT License

Copyright (c) 2025 CJ Pais

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## NVIDIA Parakeet TDT 0.6B v3

Bridge can download and run the `parakeet-tdt-0.6b-v3-int8` local
speech-to-text model for offline push-to-talk transcription. This model is
derived from NVIDIA Parakeet TDT 0.6B v3.

Model card: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3

License: CC-BY-4.0

The model is not bundled in the source tree. Bridge downloads it on demand into
the local application data directory when the organization admin enables local
push-to-talk.

## OpenAI gpt-oss models

Bridge can ask LM Studio to download and load `openai/gpt-oss-20b` or, on
premium machines selected by the admin recommendation flow, `openai/gpt-oss-120b`.

LM Studio model page: https://lmstudio.ai/models/gpt-oss

License: Apache 2.0

These models are not bundled in the source tree. Bridge delegates download and
runtime management to LM Studio on the local machine.
