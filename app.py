from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
import yt_dlp
import os
import static_ffmpeg
import threading
import uuid
import re
import shutil
import time

# FFmpeg paths add karein aur exact location find karein
static_ffmpeg.add_paths()
ffmpeg_exe = shutil.which("ffmpeg")

# Serve the frontend (index.html, style.css, script.js, manifest.json, sw.js,
# icons) directly from this Flask app so a single Render web service can host
# both the API and the static site.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Disable Flask's automatic static route: we serve frontend files ourselves
# below through an explicit whitelist so things like app.py, requirements.txt,
# .env, and the downloads/ folder are never exposed as downloadable files.
app = Flask(__name__, static_folder=None)

# CORS only needs to cover the API routes. On Render the frontend and the API
# are served from the same origin, so this is mainly a safety net for local
# development or if the frontend is ever hosted elsewhere.
CORS(app, resources={r"/api/*": {"origins": "*"}})

FRONTEND_FILES = {
    'index.html', 'style.css', 'script.js',
    'manifest.json', 'sw.js',
}

DOWNLOAD_FOLDER = os.path.join(BASE_DIR, 'downloads')
if not os.path.exists(DOWNLOAD_FOLDER):
    os.makedirs(DOWNLOAD_FOLDER)

download_tasks = {}
TASK_TTL_SECONDS = 60 * 60  # 1 hour, used to clean up old in-memory tasks


def cleanup_old_tasks():
    """Render's disk is ephemeral and this app keeps task state in memory,
    so periodically drop old finished tasks to avoid unbounded growth."""
    now = time.time()
    stale_ids = [
        t_id for t_id, task in download_tasks.items()
        if task.get('complete') and now - task.get('_created', now) > TASK_TTL_SECONDS
    ]
    for t_id in stale_ids:
        download_tasks.pop(t_id, None)

def get_clean_percent(d):
    total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
    downloaded = d.get('downloaded_bytes', 0)
    if total > 0:
        return min(99, max(1, int((downloaded / total) * 100)))
    
    p_str = d.get('_percent_str', '')
    p_str = re.sub(r'\x1b\[[0-9;]*m', '', p_str).replace('%', '').strip()
    try:
        return min(99, max(1, int(float(p_str))))
    except:
        return 10

@app.route('/api/start-download', methods=['POST'])
def start_download():
    data = request.json or {}
    video_url = data.get('url')
    raw_quality = str(data.get('quality', '720p')).lower()

    if not video_url:
        return jsonify({'error': 'URL dena zaroori hai!'}), 400

    cleanup_old_tasks()

    task_id = str(uuid.uuid4())
    download_tasks[task_id] = {
        'percent': 5,
        'status': 'Fetching video info...',
        'complete': False,
        'error': None,
        'data': None,
        '_created': time.time()
    }

    def run_yt_dlp(t_id, url, q_str):
        def progress_hook(d):
            if d['status'] == 'downloading':
                pct = get_clean_percent(d)
                download_tasks[t_id]['percent'] = pct
                download_tasks[t_id]['status'] = f'Downloading video... {pct}%'
            elif d['status'] == 'finished':
                download_tasks[t_id]['percent'] = 98
                download_tasks[t_id]['status'] = 'Merging High Quality HD Video & Audio...'

        try:
            # Dropdown/Quality string se target height extract karein (e.g. '1080p' ya '1080p full hd' -> 1080)
            height_match = re.search(r'(\d+)', q_str)
            target_height = height_match.group(1) if height_match else None

            # Base options
            ydl_opts = {
                # Unique filename format taake purani low-quality video repeat na ho
                'outtmpl': f'{DOWNLOAD_FOLDER}/%(title)s_%(height)sp_{t_id[:6]}.%(ext)s',
                'no_warnings': True,
                'merge_output_format': 'mp4',
                'progress_hooks': [progress_hook],
                'format_sort': ['res', 'fps', 'hdr:12', 'vcodec', 'acodec'],
                'overwrites': True,
                'http_headers': {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                }
            }

            if ffmpeg_exe:
                ydl_opts['ffmpeg_location'] = ffmpeg_exe

            if 'mp3' in q_str:
                ydl_opts['format'] = 'bestaudio/best'
                ydl_opts['postprocessors'] = [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                }]
            elif target_height:
                # Target height tak ki Best Video + Best Audio
                ydl_opts['format'] = f'bestvideo[height<={target_height}]+bestaudio/bestvideo[height<={target_height}]+bestaudio/best[height<={target_height}]/best'
            else:
                ydl_opts['format'] = 'bestvideo+bestaudio/best'

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(info)

                base, _ = os.path.splitext(filename)
                if os.path.exists(base + '.mp4'):
                    filename = base + '.mp4'

                downloaded_height = info.get('height') or 'HD'
                print(f"\n[✓ SUCCESS] Downloaded Video Resolution: {downloaded_height}p HD -> File: {os.path.basename(filename)}\n")

                video_id = info.get('id')
                extractor = info.get('extractor', '').lower()
                
                if video_id and 'youtube' in extractor:
                    thumbnail_url = f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"
                else:
                    thumbnail_url = info.get('thumbnail', '')
                    if not thumbnail_url and info.get('thumbnails'):
                        thumbnail_url = info.get('thumbnails')[-1].get('url', '')

                download_tasks[t_id]['percent'] = 100
                download_tasks[t_id]['status'] = f'Completed ({downloaded_height}p HD)!'
                download_tasks[t_id]['complete'] = True
                download_tasks[t_id]['data'] = {
                    'title': info.get('title', 'Video'),
                    'duration': info.get('duration', 0),
                    'thumbnail': thumbnail_url,
                    'filename': os.path.basename(filename)
                }

        except Exception as e:
            print(f"\n[X ERROR] {str(e)}\n")
            download_tasks[t_id]['error'] = str(e)
            download_tasks[t_id]['complete'] = True

    thread = threading.Thread(target=run_yt_dlp, args=(task_id, video_url, raw_quality))
    thread.start()

    return jsonify({'task_id': task_id})


@app.route('/api/progress/<task_id>', methods=['GET'])
def get_progress(task_id):
    task = download_tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify(task)


@app.route('/api/get-file/<filename>', methods=['GET'])
def get_file(filename):
    # Prevent path traversal (e.g. "../app.py") — only allow plain filenames
    # that live directly inside DOWNLOAD_FOLDER.
    safe_name = os.path.basename(filename)
    file_path = os.path.join(DOWNLOAD_FOLDER, safe_name)
    if os.path.exists(file_path):
        return send_file(file_path, as_attachment=True)
    return jsonify({'error': 'File nahi mili'}), 404


# ---------------------------------------------------------------------------
# Frontend static files (served from the same Flask app on Render)
# ---------------------------------------------------------------------------
@app.route('/')
def serve_index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/<path:filename>')
def serve_frontend(filename):
    if filename in FRONTEND_FILES:
        return send_from_directory(BASE_DIR, filename)
    if filename.startswith('icons/'):
        return send_from_directory(BASE_DIR, filename)
    return jsonify({'error': 'Not found'}), 404


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    print(f"RELTOP Server running on http://0.0.0.0:{port}")
    if ffmpeg_exe:
        print(f"FFmpeg Status: OK ({ffmpeg_exe})")
    else:
        print("FFmpeg Status: WARNING (Not found)")
    # debug=False for production-safe defaults; Render always runs via
    # gunicorn (see Procfile), this block only matters for local `python app.py` runs.
    app.run(host='0.0.0.0', port=port, debug=False)