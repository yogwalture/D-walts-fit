import { it } from 'vitest';
import { Prisma } from '@prisma/client';
it('dump', () => {
  for (const n of ['Equipment','EquipmentMaintenanceLog','EquipmentServiceSchedule','Video','VideoCategory','Playlist','PlaylistItem','VideoProgress','MemberImport','MemberImportRow','FileObject','Outbox','VerificationToken']) {
    const m = Prisma.dmmf.datamodel.models.find(x=>x.name===n);
    if (m) console.log(`${n}: ${m.fields.filter(f=>!f.relationName).map(f=>f.name).join(' ')}`);
  }
});
