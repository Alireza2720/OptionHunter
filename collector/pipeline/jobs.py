# -*- coding: utf-8 -*-
"""Job engine with phased progress tracking."""
import uuid
from datetime import datetime, timezone
from .db import get_db, COL_JOBS

def create_job(job_type, payload):
    db = get_db()
    job_id = str(uuid.uuid4())
    doc = {
        '_id': job_id,
        'type': job_type,
        'payload': payload,
        'status': 'QUEUED',
        'phase': 'init',
        'phases': {},
        'errors': [],
        'warnings': [],
        'result': None,
        'created_at': datetime.now(timezone.utc),
        'started_at': None,
        'finished_at': None,
    }
    db[COL_JOBS].insert_one(doc)
    return doc

def get_job(job_id):
    return get_db()[COL_JOBS].find_one({'_id': job_id})

def list_jobs(limit=30):
    return list(get_db()[COL_JOBS].find({}).sort('created_at', -1).limit(limit))

def update_job(job_id, **fields):
    fields['updated_at'] = datetime.now(timezone.utc)
    get_db()[COL_JOBS].update_one({'_id': job_id}, {'$set': fields})

def set_phase(job_id, name, data):
    db = get_db()
    db[COL_JOBS].update_one(
        {'_id': job_id},
        {'$set': {
            'phase': name,
            f'phases.{name}': data,
            'updated_at': datetime.now(timezone.utc),
        }}
    )

def append_error(job_id, msg, context=None):
    db = get_db()
    entry = {'msg': str(msg), 'at': datetime.now(timezone.utc)}
    if context: entry['context'] = context
    db[COL_JOBS].update_one(
        {'_id': job_id},
        {'$push': {'errors': entry}, '$set': {'updated_at': datetime.now(timezone.utc)}}
    )

def append_warning(job_id, msg):
    db = get_db()
    db[COL_JOBS].update_one(
        {'_id': job_id},
        {'$push': {'warnings': {'msg': str(msg), 'at': datetime.now(timezone.utc)}}}
    )

def finish_job(job_id, status, result=None):
    update_job(job_id, status=status, result=result, finished_at=datetime.now(timezone.utc))

def cancel_job(job_id):
    update_job(job_id, status='CANCELLED', finished_at=datetime.now(timezone.utc))

def is_cancelled(job_id):
    j = get_job(job_id)
    return bool(j and j.get('status') == 'CANCELLED')