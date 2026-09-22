#!/usr/bin/env bash
# Runs INSIDE the Android image, as the sandbox user, with /dev/kvm passed in.
# Proves the thing the image exists for: a Flutter app whose startup calls a
# native-only plugin (Firebase) boots, and an agent can read, tap and
# screenshot it. Firebase is initialized with explicit throwaway options, so
# no project or google-services.json is needed and nothing leaves the runner.
set -euo pipefail
out=${1:-/tmp/qa}
mkdir -p "$out"

cd "${SMOKE_WORKDIR:-/app}"
flutter create smoke --platforms=android --org com.example >/dev/null
cd smoke
flutter pub add firebase_core >/dev/null
cat > lib/main.dart <<'EOF'
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  var status = 'firebase: ok';
  try {
    await Firebase.initializeApp(
      options: const FirebaseOptions(
        apiKey: 'AIzaSyA-smoke-test-not-a-real-key-000000',
        appId: '1:1234567890:android:0123456789abcdef',
        messagingSenderId: '1234567890',
        projectId: 'qa-android-smoke',
      ),
    );
  } catch (e) {
    status = 'firebase: failed $e';
  }
  runApp(SmokeApp(status: status));
}

class SmokeApp extends StatefulWidget {
  const SmokeApp({super.key, required this.status});
  final String status;
  @override
  State<SmokeApp> createState() => _SmokeAppState();
}

class _SmokeAppState extends State<SmokeApp> {
  int count = 0;
  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(widget.status),
              Text('count: $count'),
            ]),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => setState(() => count++),
            tooltip: 'Increment',
            child: const Icon(Icons.add),
          ),
        ),
      );
}
EOF

# A git repo with Flutter's standard .gitignore, to prove a run leaves nothing
# for the daemon to checkpoint onto the branch.
git init -q
git -c user.email=smoke@example.com -c user.name=smoke add -A
git -c user.email=smoke@example.com -c user.name=smoke commit -qm init

start=$(date +%s)
qa-android start
echo "smoke: emulator boot + build + launch took $(( $(date +%s) - start ))s"

qa-android shot "$out/before.png" >/dev/null
qa-android ui | tee "$out/ui-before.txt"
grep -q "firebase: ok" "$out/ui-before.txt" \
  || { echo "smoke: Firebase did not initialize"; qa-android logs 80; exit 1; }

# Tap by label, the way the skill tells agents to.
xy=$(grep -m1 "Increment" "$out/ui-before.txt" | cut -f1 | cut -d' ' -f1)
[ -n "$xy" ] || { echo "smoke: no Increment button in the accessibility tree"; exit 1; }
t0=$(date +%s%N)
qa-android tap "${xy%,*}" "${xy#*,}"
sleep 1
qa-android shot "$out/after.png" >/dev/null
echo "smoke: tap + screenshot took $(( ($(date +%s%N) - t0) / 1000000 ))ms (incl. 1s settle)"
qa-android ui | tee "$out/ui-after.txt"
grep -q "count: 1" "$out/ui-after.txt" \
  || { echo "smoke: the tap did not reach the app"; exit 1; }
cmp -s "$out/before.png" "$out/after.png" \
  && { echo "smoke: screenshot unchanged after the tap"; exit 1; }

dirty=$(git status --porcelain --untracked-files=all)
[ -z "$dirty" ] || { echo "smoke: the build left files for the daemon to commit:"; echo "$dirty"; exit 1; }

qa-android stop >/dev/null
echo "smoke: drove a Flutter + Firebase app on the emulator"
