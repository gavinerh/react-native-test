import immutablePersistenceTransform from '../Services/ImmutablePersistenceTransform'
import { AsyncStorage } from 'react-native'

// More info here:  https://shift.infinite.red/shipping-persistant-reducers-7341691232b1
const REDUX_PERSIST = {
  active: true,
  reducerVersion: '1.0', // IMPORTANT: changing the version purges the store (should only be used to force reset with new versions)
  storeConfig: {
    storage: AsyncStorage,
    blacklist: ['search', 'nav', 'hydrationCompleted', 'serverSyncStatus', 'giftedchatmessages', 'guistate'], // reducer keys that you do NOT want stored to persistence here
    // whitelist: [], Optionally, just specify the keys you DO want stored to
    // persistence. An empty array means 'don't store any reducers' -> infinitered/ignite#409
    transforms: [immutablePersistenceTransform]
  }
}

export default REDUX_PERSIST