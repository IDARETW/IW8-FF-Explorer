import importlib.util
from pathlib import Path
import struct
import unittest
import zlib

spec = importlib.util.spec_from_file_location('script_previews', Path(__file__).resolve().parents[1] / 'scripts/script_previews.py')
scripts = importlib.util.module_from_spec(spec); spec.loader.exec_module(scripts)

class ScriptTests(unittest.TestCase):
    def test_container_lengths_compression_and_expansion_are_validated(self):
        stack=b'synthetic'; compressed=zlib.compress(stack)
        data=b'GSC\0'+struct.pack('<III',len(compressed),len(stack),1)+compressed+b'\x3b'
        scripts.validate(data)
        for invalid in [b'not gsc',data[:-1],data+b'X',data[:8]+struct.pack('<I',1)+data[12:],data[:16]+b'X'*len(compressed)+b'\x3b']:
            with self.assertRaises(ValueError): scripts.validate(invalid)
        with self.assertRaises(ValueError): scripts.validate(data[:8]+struct.pack('<I',17*1024**2)+data[12:])
