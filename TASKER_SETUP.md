# Tasker + AutoRemote Setup Guide

## Auto-start Kiwi Browser on Android when cURL request arrives

---

## Prerequisites

1. **Tasker** (Premium) - Already installed
2. **AutoRemote** (free) - Install from Play Store
3. **Kiwi Browser** - Already installed with FlowKit extension

---

## Step 1: Configure AutoRemote

1. Open **AutoRemote** app on Android
2. Sign in with your Google account (if prompted)
3. Copy the **Key** shown (it can be short like `wG8e1B8B` or long like an FCM token)
4. Your message URL will be:
   ```
   https://autoremotejoaomgcd.appspot.com/sendmessage?key=YOUR_KEY&message=w
   ```
5. **Test this URL in your phone browser first** - if Kiwi launches, it works!

---

## Step 2: Create Tasker Task

1. Open **Tasker**
2. Go to **Tasks** tab
3. Tap `+` button (bottom right)
4. Name it: `WakeKiwi`
5. Tap `✓`

### Add Action: Launch Kiwi Browser

1. Tap `+` button (bottom)
2. Go to: **App** → **Send Intent**
3. Configure:
   - **Action**: `android.intent.action.MAIN`
   - **Cat**: `Launcher`
   - **Pkg**: `com.kiwibrowser.browser`
   - **Cls**: `com.kiwibrowser.browser.Main`
   - **Target**: `Activity`
4. Tap `←` to go back

Your task should look like:
```
WakeKiwi
  A1: Send Intent [ Action:android.intent.action.MAIN Cat:Launcher Pkg:com.kiwibrowser.browser Cls:com.kiwibrowser.browser.Main Target:Activity ]
```

---

## Step 3: Create AutoRemote Profile in Tasker

1. Open **Tasker**
2. Go to **Profiles** tab
3. Tap `+` button
4. Select: **Event** → **Plugin** → **AutoRemote**
5. Tap the **pencil/edit** icon next to "Config"
6. In the AutoRemote config screen:
   - Tap **Add Message Match** (or type in the message field)
   - Type: `w`
   - Tap **✓** or **Done**
7. Press **back** to return to Tasker
8. Tasker will prompt: **"Link Task?"**
9. Select: `WakeKiwi` from the list

Your Profile should now look like:
```
Profile: AutoRemote WakeKiwi
  Event: Plugin → AutoRemote [ Config: w ]
  Enter: WakeKiwi
```

---

## Step 4: Register Device with Server

Run this command on your server (replace with your actual AutoRemote URL):

```bash
curl -X POST "http://your-server:8100/api/tasker/register" \
  -H "Content-Type: application/json" \
  -d '{
    "tasker_url": "https://autoremotejoaomgcd.appspot.com/sendmessage?key=YOUR_KEY_HERE",
    "device_name": "My Android Phone"
  }'
```

Note: The URL should be the base `/sendmessage` endpoint with your key. The `&message=w` part is added automatically by the server.

---

## Step 5: Test It

### Quick AutoRemote test (open on phone browser):
Open this URL on your Android phone (replace YOUR_KEY with your actual key):
```
https://autoremotejoaomgcd.appspot.com/sendmessage?key=YOUR_KEY&message=w
```
If Kiwi launches → AutoRemote + Tasker setup is correct!

### Server-side test:
List registered devices:
```bash
curl "http://your-server:8100/api/tasker/devices"
```

### Send test wake-up:
```bash
curl -X POST "http://your-server:8100/api/tasker/test/0"
```

If Kiwi Browser launches on your Android device → **SUCCESS!**

---

## Step 6: Use It

Now when you send a cURL request and Kiwi is closed:

```bash
curl -X POST "http://your-server:8100/api/generate" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a beautiful sunset over mountains", "aspect_ratio": "16:9"}'
```

The flow will be:
1. Server detects no extension connected
2. Sends wake-up to your Android device via AutoRemote
3. Tasker launches Kiwi Browser
4. Extension loads and connects to server
5. Image generation proceeds automatically
6. Response returned to cURL

**Note**: First request after Kiwi is closed will take ~10-20 seconds longer (cold start time).

---

## Troubleshooting

### Kiwi doesn't launch on test
- Check AutoRemote URL is correct (has your key)
- Check Tasker Profile exists with AutoRemote Event
- Check message match is exactly `w` (case-sensitive)
- Check Profile is linked to your Kiwi launch task
- Check Tasker is running (not killed by battery optimization)

### Profile not triggering
- In Tasker, make sure the Profile is **enabled** (checkbox ticked)
- Test by opening this URL in your phone browser:
  ```
  https://autoremotejoaomgcd.appspot.com/sendmessage?key=YOUR_KEY&message=w
  ```
- If it works in browser but not from server, check server logs

### Tasker gets killed by Android
1. Go to **Settings** → **Battery** → **Battery Optimization**
2. Find **Tasker** → Set to **Don't optimize**
3. Do the same for **AutoRemote**

### AutoRemote URL not working
- Open the URL in your browser to test:
  ```
   https://autoremotejoaomgcd.appspot.com/sendmessage?key=YOUR_KEY&message=w
  ```
- Should see "Message received" or similar response

### Check server logs
```bash
# On server, watch logs for Tasker-related messages
tail -f logs.txt | grep -i tasker
```

You should see:
```
INFO: Registered Tasker device: My Android Phone
INFO: No extensions connected. Sending Tasker wake-up to Android devices...
INFO: Wake-up broadcast: 1/1 devices notified
INFO: Extension connected after Tasker wake-up
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tasker/register` | POST | Register a device |
| `/api/tasker/unregister` | POST | Remove a device |
| `/api/tasker/devices` | GET | List all devices |
| `/api/tasker/test/{index}` | POST | Send test wake-up |

---

## Register Multiple Devices

You can register multiple Android devices for redundancy:

```bash
# Device 1
curl -X POST "http://your-server:8100/api/tasker/register" \
  -d '{"tasker_url": "https://autoremotejoaomgcd.appspot.com/sendmessage?key=KEY1", "device_name": "Phone"}'

# Device 2
curl -X POST "http://your-server:8100/api/tasker/register" \
  -d '{"tasker_url": "https://autoremotejoaomgcd.appspot.com/sendmessage?key=KEY2", "device_name": "Tablet"}'
```

When a request comes in, **all registered devices** will receive the wake-up signal simultaneously.
