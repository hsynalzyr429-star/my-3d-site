"""AI 3D Studio web API.

The web server is intentionally separated from TRELLIS.2's heavyweight inference
code. Start this file inside the TRELLIS.2 conda environment on a CUDA Linux host.
"""
from __future__ import annotations

import io
import os
import sys
import uuid
import time
import secrets
import threading
import traceback
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps, UnidentifiedImageError

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"
DATA_DIR = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve()
UPLOAD_DIR = DATA_DIR / "uploads"
RESULT_DIR = DATA_DIR / "results"
TRELLIS2_ROOT = Path(os.getenv("TRELLIS2_ROOT", str(ROOT / "TRELLIS.2"))).resolve()
APP_ACCESS_KEY = os.getenv("APP_ACCESS_KEY", "").strip()
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "15")) * 1024 * 1024

for directory in (UPLOAD_DIR, RESULT_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="AI 3D Studio API", version="1.0.0")
_origins = [item.strip() for item in os.getenv("CORS_ORIGINS", "").split(",") if item.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=_origins, allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Access-Key"],
    )
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

# The GPU model must only run one generation at a time on a single GPU.
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="trellis-worker")
model_lock = threading.Lock()
tasks_lock = threading.Lock()
tasks: dict[str, dict[str, Any]] = {}
_pipeline = None
_pipeline_loading_error: str | None = None


def _check_access(key: str | None) -> None:
    if APP_ACCESS_KEY and not secrets.compare_digest(key or "", APP_ACCESS_KEY):
        raise HTTPException(status_code=401, detail="رمز الوصول غير صحيح.")


def _set_task(task_id: str, **updates: Any) -> None:
    with tasks_lock:
        task = tasks.get(task_id)
        if task is not None:
            task.update(updates)
            task["updated_at"] = time.time()


def _get_pipeline():
    """Load TRELLIS.2 once, on the first actual generation request."""
    global _pipeline, _pipeline_loading_error
    if _pipeline is not None:
        return _pipeline
    if not TRELLIS2_ROOT.exists():
        raise RuntimeError(
            f"لم يتم العثور على مستودع TRELLIS.2 في: {TRELLIS2_ROOT}. "
            "نفّذ scripts/setup_gpu.sh أولاً."
        )
    # Several TRELLIS.2 configs/assets are addressed relative to the repository.
    os.chdir(TRELLIS2_ROOT)
    if str(TRELLIS2_ROOT) not in sys.path:
        sys.path.insert(0, str(TRELLIS2_ROOT))
    try:
        import torch
        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        if not torch.cuda.is_available():
            raise RuntimeError("لا توجد بطاقة NVIDIA/CUDA متاحة. شغّل الخادم على GPU متوافق.")
        _set_boot_status("loading")
        pipe = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
        pipe.cuda()
        _pipeline = pipe
        _pipeline_loading_error = None
        _set_boot_status("ready")
        return _pipeline
    except Exception as exc:
        _pipeline_loading_error = f"{type(exc).__name__}: {exc}"
        _set_boot_status("error")
        raise


_boot_status = "not_loaded"


def _set_boot_status(value: str) -> None:
    global _boot_status
    _boot_status = value


def _infer_and_export(task_id: str, input_path: Path, settings: dict[str, Any]) -> None:
    """Run the official TRELLIS.2 inference + GLB extraction sequence."""
    output_path = RESULT_DIR / f"{task_id}.glb"
    started = time.time()
    try:
        _set_task(task_id, status="running", stage="loading_model", progress=8,
                  indeterminate=False, message="فحص البيئة وتحميل نموذج الذكاء الاصطناعي عند الحاجة…")
        with model_lock:
            pipe = _get_pipeline()
            import torch
            import o_voxel

            _set_task(task_id, status="running", stage="preprocessing", progress=18,
                      indeterminate=False, message="تنظيف الصورة وتجهيز الجسم المدخل…")
            with Image.open(input_path) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGBA")
            # Use the same preprocessing entry point used by the official TRELLIS.2 demo.
            image = pipe.preprocess_image(image)

            resolution = settings["resolution"]
            pipeline_type = {"512": "512", "1024": "1024_cascade", "1536": "1536_cascade"}[resolution]
            seed = settings["seed"]
            _set_task(task_id, stage="generating", progress=30, indeterminate=True,
                      message=f"توليد الشكل والخامات على GPU — الجودة {resolution}³. هذه المرحلة لا تعرض نسبة دقيقة من النموذج.")
            with torch.inference_mode():
                outputs, latents = pipe.run(
                    image,
                    seed=seed,
                    preprocess_image=False,
                    sparse_structure_sampler_params={
                        "steps": 12,
                        "guidance_strength": 7.5,
                        "guidance_rescale": 0.7,
                        "rescale_t": 5.0,
                    },
                    shape_slat_sampler_params={
                        "steps": 12,
                        "guidance_strength": 7.5,
                        "guidance_rescale": 0.5,
                        "rescale_t": 3.0,
                    },
                    tex_slat_sampler_params={
                        "steps": 12,
                        "guidance_strength": 1.0,
                        "guidance_rescale": 0.0,
                        "rescale_t": 3.0,
                    },
                    pipeline_type=pipeline_type,
                    return_latent=True,
                )

                _set_task(task_id, stage="exporting", progress=85, indeterminate=False,
                          message="استخراج الشبكة الهندسية وتعبئة الخامة في GLB…")
                shape_slat, tex_slat, grid_size = latents
                mesh = pipe.decode_latent(shape_slat, tex_slat, grid_size)[0]
                # nvdiffrast's documented simplification ceiling.
                mesh.simplify(16_777_216)
                glb = o_voxel.postprocess.to_glb(
                    vertices=mesh.vertices,
                    faces=mesh.faces,
                    attr_volume=mesh.attrs,
                    coords=mesh.coords,
                    attr_layout=pipe.pbr_attr_layout,
                    grid_size=grid_size,
                    aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                    decimation_target=settings["face_count"],
                    texture_size=settings["texture_size"],
                    remesh=True,
                    remesh_band=1,
                    remesh_project=0,
                    use_tqdm=False,
                )
                glb.export(str(output_path), extension_webp=True)
                del outputs, latents, mesh, glb
                torch.cuda.empty_cache()

        _set_task(task_id, status="completed", stage="completed", progress=100,
                  indeterminate=False, message="اكتمل إنشاء المجسّم. يمكنك معاينته وتنزيل ملف GLB.",
                  result_url=f"/api/tasks/{task_id}/download",
                  elapsed_seconds=round(time.time() - started, 1),
                  file_size=output_path.stat().st_size if output_path.exists() else None)
    except Exception as exc:
        traceback.print_exc()
        _set_task(task_id, status="failed", stage="failed", progress=0,
                  indeterminate=False,
                  message="فشل إنشاء المجسّم. تحقق من سجل الخادم وإعدادات GPU.",
                  error=f"{type(exc).__name__}: {exc}",
                  elapsed_seconds=round(time.time() - started, 1))


def _cleanup_tasks() -> None:
    """Delete stale task files after 24 hours; no upload history is retained indefinitely."""
    cutoff = time.time() - 24 * 60 * 60
    with tasks_lock:
        expired = [tid for tid, item in tasks.items() if item.get("updated_at", 0) < cutoff]
        for tid in expired:
            item = tasks.pop(tid, {})
            for key in ("input_path",):
                path = item.get(key)
                if path:
                    try:
                        Path(path).unlink(missing_ok=True)
                    except OSError:
                        pass
            (RESULT_DIR / f"{tid}.glb").unlink(missing_ok=True)


@app.get("/", response_class=HTMLResponse)
def index():
    return (WEB_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/guide", response_class=HTMLResponse)
def guide():
    return (WEB_DIR / "guide.html").read_text(encoding="utf-8")


@app.get("/privacy", response_class=HTMLResponse)
def privacy():
    return (WEB_DIR / "privacy.html").read_text(encoding="utf-8")


@app.get("/api/health")
def health():
    gpu_name = None
    cuda_ok = False
    try:
        import torch
        cuda_ok = bool(torch.cuda.is_available())
        if cuda_ok:
            gpu_name = torch.cuda.get_device_name(0)
    except Exception:
        pass
    with tasks_lock:
        active = sum(1 for item in tasks.values() if item.get("status") in {"queued", "running"})
    return {
        "ok": True,
        "engine": "TRELLIS.2-4B",
        "model_status": _boot_status,
        "cuda_available": cuda_ok,
        "gpu_name": gpu_name,
        "active_jobs": active,
        "access_key_required": bool(APP_ACCESS_KEY),
        "model_loading_error": _pipeline_loading_error,
    }


@app.post("/api/generate")
async def generate(
    image: UploadFile = File(...),
    resolution: str = Form("1024"),
    face_count: int = Form(300000),
    texture_size: int = Form(2048),
    seed: int = Form(-1),
    x_access_key: str | None = Header(default=None, alias="X-Access-Key"),
):
    _check_access(x_access_key)
    _cleanup_tasks()

    if image.content_type not in {"image/png", "image/jpeg", "image/webp", "image/jpg"}:
        raise HTTPException(status_code=415, detail="ارفع صورة PNG أو JPG أو WebP فقط.")
    if resolution not in {"512", "1024", "1536"}:
        raise HTTPException(status_code=422, detail="قيمة الدقة غير مدعومة.")
    if face_count not in {100000, 300000, 500000, 800000}:
        raise HTTPException(status_code=422, detail="عدد الوجوه غير مدعوم.")
    if texture_size not in {1024, 2048, 4096}:
        raise HTTPException(status_code=422, detail="حجم الخامة غير مدعوم.")

    content = await image.read(MAX_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="الملف فارغ.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"حجم الصورة يتجاوز {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    try:
        with Image.open(io.BytesIO(content)) as im:
            if im.width > 8192 or im.height > 8192:
                raise HTTPException(status_code=413, detail="أبعاد الصورة كبيرة جداً؛ قلّصها إلى أقل من 8192 بكسل لكل ضلع.")
            im.verify()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="تعذّر قراءة الصورة. جرّب ملف PNG أو JPG صالحاً.") from exc

    task_id = uuid.uuid4().hex
    input_path = UPLOAD_DIR / f"{task_id}.image"
    input_path.write_bytes(content)
    settings = {
        "resolution": resolution,
        "face_count": face_count,
        "texture_size": texture_size,
        "seed": int(seed) if int(seed) >= 0 else secrets.randbelow(2**31 - 1),
    }
    with tasks_lock:
        tasks[task_id] = {
            "task_id": task_id,
            "status": "queued",
            "stage": "queued",
            "progress": 2,
            "indeterminate": False,
            "message": "أُضيفت المهمة إلى قائمة GPU.",
            "created_at": time.time(),
            "updated_at": time.time(),
            "input_path": str(input_path),
            "settings": settings,
        }
    executor.submit(_infer_and_export, task_id, input_path, settings)
    return JSONResponse({"task_id": task_id, "status": "queued", "message": "بدأت المهمة."}, status_code=202)


@app.get("/api/tasks/{task_id}")
def task_status(task_id: str, x_access_key: str | None = Header(default=None, alias="X-Access-Key")):
    _check_access(x_access_key)
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="المهمة غير موجودة أو انتهت صلاحيتها.")
        public = {k: v for k, v in task.items() if k not in {"input_path", "settings"}}
        return public


@app.get("/api/tasks/{task_id}/download")
def download(task_id: str, x_access_key: str | None = Header(default=None, alias="X-Access-Key")):
    _check_access(x_access_key)
    path = RESULT_DIR / f"{task_id}.glb"
    with tasks_lock:
        task = tasks.get(task_id)
    if task is None or task.get("status") != "completed" or not path.exists():
        raise HTTPException(status_code=404, detail="لم يصبح ملف المجسّم جاهزاً بعد.")
    return FileResponse(path, media_type="model/gltf-binary", filename="ai-3d-model.glb")


@app.get("/api/tasks/{task_id}/preview")
def preview(task_id: str, x_access_key: str | None = Header(default=None, alias="X-Access-Key")):
    _check_access(x_access_key)
    path = RESULT_DIR / f"{task_id}.glb"
    if not path.exists():
        raise HTTPException(status_code=404, detail="المجسّم غير متاح.")
    return FileResponse(path, media_type="model/gltf-binary", filename=f"{task_id}.glb")
