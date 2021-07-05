import {
  DataTypes,
  ModelDefined,
  Sequelize,
} from 'sequelize';

import {
  AddressCreationInfo,
  AddressInfo,
} from '@src/types';

export const init = (sequelize: Sequelize): ModelDefined<AddressInfo, AddressCreationInfo> => {
  const address: ModelDefined<AddressInfo, AddressCreationInfo> = sequelize.define(
    'Address',
    {
      index: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },
      address: {
        type: new DataTypes.STRING(128),
        allowNull: false,
      },
      wallet_id: {
        type: new DataTypes.STRING(128),
        allowNull: false,
      },
      transactions: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },
    },
    {
      tableName: 'address',
    },
  );
  return address;
};
