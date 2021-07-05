import {
  sequelize,
} from '@src/orm';
import { init as initAddress } from '@src/models/address';

export const address = initAddress(sequelize);
